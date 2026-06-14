"""Stage C colorizer — DIFFUSION (the real one). ControlNet on Stable Diffusion
1.5, conditioned on 4-band Sentinel-1 quad-pol SAR, generates optical (RGB).

Why this over the pix2pix baseline: pix2pix's L1 loss averages -> blur. A
ControlNet-conditioned latent diffusion reuses SD's pretrained image prior (sharp
texture) while the trainable ControlNet branch injects SAR structure. This is the
proven sharp path for image-conditioned generation (and what the SAR->optical
diffusion literature uses). Frozen: VAE, UNet, CLIP text encoder (empty prompt).
Trained: ControlNet only. Single RTX 5090, bf16.

Base: stable-diffusion-v1-5/stable-diffusion-v1-5 (ungated mirror; SD-2.1-base 401s
without a token). VAE scaling_factor from config. eps-prediction MSE loss.

Data: SpaceNet 6 (Capella 0.5 m quad-pol SAR <-> Maxar WV-2 RGB, co-registered).

Usage:
  python colorize_diffusion.py --data data/train --out runs/diffusion [--smoke]
"""

from __future__ import annotations

import argparse
import glob
import os
import time

import numpy as np
import rasterio
import torch
import torch.nn.functional as F
from diffusers import AutoencoderKL, ControlNetModel, DDIMScheduler, DDPMScheduler, UNet2DConditionModel
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from transformers import CLIPTextModel, CLIPTokenizer

BASE = "stable-diffusion-v1-5/stable-diffusion-v1-5"
SAR_CLIP = 50.0


class SN6Diff(Dataset):
    """Co-registered SAR(4ch,[0,1]) -> optical(3ch,[-1,1]) pairs, 512 random crop."""

    def __init__(self, root: str, crop: int = 512, min_content: float = 0.3):
        sar = glob.glob(os.path.join(root, "**", "SAR-Intensity", "*.tif"), recursive=True)
        self.pairs = [(s, s.replace("SAR-Intensity", "PS-RGB")) for s in sar
                      if os.path.exists(s.replace("SAR-Intensity", "PS-RGB"))]
        self.crop, self.min_content = crop, min_content
        if not self.pairs:
            raise RuntimeError(f"no SAR/PS-RGB pairs under {root}")

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, i):
        c = self.crop
        for _ in range(8):
            s, r = self.pairs[i]
            with rasterio.open(s) as f:
                sar = f.read().astype(np.float32)
            with rasterio.open(r) as f:
                rgb = f.read().astype(np.float32)
            _, H, W = sar.shape
            if H < c or W < c:
                i = np.random.randint(0, len(self.pairs)); continue
            y0, x0 = np.random.randint(0, H - c + 1), np.random.randint(0, W - c + 1)
            sar = sar[:, y0:y0 + c, x0:x0 + c]
            rgb = rgb[:, y0:y0 + c, x0:x0 + c]
            if (rgb.max(0) > 8).mean() >= self.min_content:
                break
            i = np.random.randint(0, len(self.pairs))
        sar = np.clip(sar, 0, SAR_CLIP) / SAR_CLIP            # [0,1] ControlNet hint
        rgb = np.clip(rgb, 0, 255) / 127.5 - 1.0              # [-1,1] VAE input (PS-RGB is uint8)
        return torch.from_numpy(sar), torch.from_numpy(rgb)


def load_models(dev):
    vae = AutoencoderKL.from_pretrained(BASE, subfolder="vae").to(dev)
    unet = UNet2DConditionModel.from_pretrained(BASE, subfolder="unet").to(dev)
    tok = CLIPTokenizer.from_pretrained(BASE, subfolder="tokenizer")
    txt = CLIPTextModel.from_pretrained(BASE, subfolder="text_encoder").to(dev)
    sched = DDPMScheduler.from_pretrained(BASE, subfolder="scheduler")
    controlnet = ControlNetModel.from_unet(unet, conditioning_channels=4).to(dev)
    for m in (vae, unet, txt):
        m.requires_grad_(False); m.eval()
    return vae, unet, tok, txt, sched, controlnet


def empty_text(tok, txt, bs, dev):
    ids = tok([""] * bs, padding="max_length", max_length=tok.model_max_length,
              truncation=True, return_tensors="pt").input_ids.to(dev)
    return txt(ids)[0]


@torch.no_grad()
def sample(vae, unet, controlnet, enc, sar, steps=40):
    """DDIM sample optical from SAR hint. Returns RGB uint8 (B,3,H,W)."""
    dev = sar.device
    ddim = DDIMScheduler.from_pretrained(BASE, subfolder="scheduler")
    ddim.set_timesteps(steps)
    sf = vae.config.scaling_factor
    lat = torch.randn(sar.shape[0], 4, sar.shape[2] // 8, sar.shape[3] // 8, device=dev)
    lat *= ddim.init_noise_sigma
    for t in ddim.timesteps:
        with torch.autocast("cuda", dtype=torch.bfloat16):
            down, mid = controlnet(lat, t, encoder_hidden_states=enc,
                                   controlnet_cond=sar, return_dict=False)
            eps = unet(lat, t, encoder_hidden_states=enc,
                       down_block_additional_residuals=down,
                       mid_block_additional_residual=mid).sample
        lat = ddim.step(eps.float(), t, lat).prev_sample
    img = vae.decode(lat / sf).sample
    return ((img.clamp(-1, 1) + 1) * 127.5).byte()


def dump(sar, gen, real, path):
    s = (sar[:, 0:1].repeat(1, 3, 1, 1).clamp(0, 1) * 255).byte().cpu().numpy()
    g = gen.cpu().numpy()
    r = ((real.clamp(-1, 1) + 1) * 127.5).byte().cpu().numpy()
    rows = [np.concatenate([np.transpose(s[i], (1, 2, 0)),
                            np.transpose(g[i], (1, 2, 0)),
                            np.transpose(r[i], (1, 2, 0))], 1) for i in range(min(4, g.shape[0]))]
    Image.fromarray(np.concatenate(rows, 0)).save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="runs/diffusion")
    ap.add_argument("--epochs", type=int, default=400)
    ap.add_argument("--bs", type=int, default=4)
    ap.add_argument("--crop", type=int, default=512)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--accum", type=int, default=2)
    ap.add_argument("--sample_every", type=int, default=500)
    ap.add_argument("--ckpt_every", type=int, default=2000)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    os.makedirs(os.path.join(a.out, "samples"), exist_ok=True)
    torch.set_float32_matmul_precision("high")

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ds = SN6Diff(a.data, crop=a.crop)
    print(f"device={dev} pairs={len(ds)} bs={a.bs} accum={a.accum}", flush=True)
    dl = DataLoader(ds, batch_size=a.bs, shuffle=True, num_workers=10, drop_last=True,
                    pin_memory=True, persistent_workers=True, prefetch_factor=4)

    vae, unet, tok, txt, sched, controlnet = load_models(dev)
    # Loss target + sampler both assume epsilon-prediction. Fail loudly if the
    # base ever points at a v-prediction checkpoint (e.g. an *-v model).
    assert sched.config.prediction_type == "epsilon", (
        f"base scheduler is {sched.config.prediction_type}; this trainer assumes epsilon"
    )
    print("models loaded; controlnet params trainable", flush=True)
    opt = torch.optim.AdamW(controlnet.parameters(), lr=a.lr)
    sf = vae.config.scaling_factor

    step = 0
    epochs = 1 if a.smoke else a.epochs
    for ep in range(epochs):
        for sar, rgb in dl:
            sar, rgb = sar.to(dev), rgb.to(dev)
            with torch.no_grad():
                lat = vae.encode(rgb).latent_dist.sample() * sf
                enc = empty_text(tok, txt, sar.shape[0], dev)
            noise = torch.randn_like(lat)
            t = torch.randint(0, sched.config.num_train_timesteps, (sar.shape[0],), device=dev).long()
            noisy = sched.add_noise(lat, noise, t)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                down, mid = controlnet(noisy, t, encoder_hidden_states=enc,
                                       controlnet_cond=sar, return_dict=False)
                eps = unet(noisy, t, encoder_hidden_states=enc,
                           down_block_additional_residuals=down,
                           mid_block_additional_residual=mid).sample
            loss = F.mse_loss(eps.float(), noise.float()) / a.accum
            loss.backward()
            if (step + 1) % a.accum == 0:
                opt.step(); opt.zero_grad(set_to_none=True)
            if step % 50 == 0:
                print(f"ep{ep} step{step} loss={loss.item() * a.accum:.4f} t={time.strftime('%H:%M:%S')}", flush=True)
            if step % a.sample_every == 0:
                controlnet.eval()
                gen = sample(vae, unet, controlnet, enc[: min(4, sar.shape[0])], sar[:4])
                dump(sar[:4], gen, rgb[:4], os.path.join(a.out, "samples", f"step_{step:07d}.png"))
                controlnet.train()
            if step and step % a.ckpt_every == 0:
                controlnet.save_pretrained(os.path.join(a.out, "controlnet"))
            step += 1
            if a.smoke and step >= 3:
                assert torch.isfinite(loss), "non-finite loss"
                gen = sample(vae, unet, controlnet, enc[:2], sar[:2], steps=4)
                dump(sar[:2], gen, rgb[:2], os.path.join(a.out, "samples", "smoke.png"))
                mem = torch.cuda.max_memory_allocated() / 1e9
                print(f"SMOKE_OK vram_peak={mem:.1f}GB", flush=True)
                return
    if step % a.accum != 0:  # flush trailing partial accumulation window
        opt.step(); opt.zero_grad(set_to_none=True)
    controlnet.save_pretrained(os.path.join(a.out, "controlnet"))
    print("TRAIN_DONE", flush=True)


if __name__ == "__main__":
    main()
