"""Stage C colorizer — SAR -> optical (cross-modal colorization), trainable now.

Baseline architecture: conditional U-Net generator (4-band SAR intensity -> 3-band
RGB) + 70x70 PatchGAN discriminator, L1 (lambda=100) + LSGAN loss (pix2pix). This
is the FIRST trainable colorizer — a real, verifiable SAR->color model, not the
final system. The reference-conditioned latent-diffusion upgrade (Spec 5★ Stage C)
comes next; this baseline establishes the data path, metrics, and a result to beat.

Trained on SpaceNet 6 (Capella 0.5 m quad-pol SAR <-> Maxar WorldView-2 RGB,
co-registered, Rotterdam). Runs on a single RTX 5090 (bf16).

Usage:
  python colorize_train.py --data <SN6 root> --out runs/colorizer [--smoke]
"""

from __future__ import annotations

import argparse
import glob
import os
import time

import numpy as np
import rasterio
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset

SAR_CLIP = 50.0  # SAR intensity clip before scaling to [-1,1]


# ----------------------------- data -----------------------------
class SN6Pairs(Dataset):
    def __init__(self, root: str, crop: int = 512, min_content: float = 0.3):
        sar = glob.glob(os.path.join(root, "**", "SAR-Intensity", "*.tif"), recursive=True)
        self.pairs = []
        for s in sar:
            r = s.replace("SAR-Intensity", "PS-RGB")
            if os.path.exists(r):
                self.pairs.append((s, r))
        self.crop = crop
        self.min_content = min_content
        if not self.pairs:
            raise RuntimeError(f"no SAR/PS-RGB pairs under {root}")

    def __len__(self) -> int:
        return len(self.pairs)

    def _read(self, s: str, r: str):
        with rasterio.open(s) as f:
            sar = f.read().astype(np.float32)  # (4,H,W)
        with rasterio.open(r) as f:
            rgb = f.read().astype(np.float32)  # (3,H,W)
        return sar, rgb

    def __getitem__(self, i: int):
        for _ in range(8):  # retry to dodge mostly-empty crops
            s, r = self.pairs[i]
            sar, rgb = self._read(s, r)
            _, H, W = sar.shape
            c = self.crop
            if H < c or W < c:
                sar = np.pad(sar, ((0, 0), (0, max(0, c - H)), (0, max(0, c - W))))
                rgb = np.pad(rgb, ((0, 0), (0, max(0, c - H)), (0, max(0, c - W))))
                _, H, W = sar.shape
            y0 = np.random.randint(0, H - c + 1)
            x0 = np.random.randint(0, W - c + 1)
            sar = sar[:, y0 : y0 + c, x0 : x0 + c]
            rgb = rgb[:, y0 : y0 + c, x0 : x0 + c]
            if (rgb.max(0) > 8).mean() >= self.min_content:
                break
            i = np.random.randint(0, len(self.pairs))
        sar = np.clip(sar, 0, SAR_CLIP) / (SAR_CLIP / 2) - 1.0
        rgb = rgb / 127.5 - 1.0
        return torch.from_numpy(sar), torch.from_numpy(rgb)


# ----------------------------- models -----------------------------
def _block(i, o, down=True, bn=True, drop=False):
    if down:
        layers = [nn.Conv2d(i, o, 4, 2, 1, bias=not bn)]
    else:
        layers = [nn.ConvTranspose2d(i, o, 4, 2, 1, bias=not bn)]
    if bn:
        layers.append(nn.BatchNorm2d(o))
    if drop:
        layers.append(nn.Dropout(0.5))
    layers.append(nn.LeakyReLU(0.2, True) if down else nn.ReLU(True))
    return nn.Sequential(*layers)


class UNetG(nn.Module):
    """U-Net generator, 4-band SAR -> 3-band RGB (tanh)."""

    def __init__(self, ic=4, oc=3, nf=64):
        super().__init__()
        self.d1 = nn.Sequential(nn.Conv2d(ic, nf, 4, 2, 1), nn.LeakyReLU(0.2, True))
        self.d2, self.d3, self.d4 = _block(nf, nf * 2), _block(nf * 2, nf * 4), _block(nf * 4, nf * 8)
        self.d5, self.d6, self.d7 = _block(nf * 8, nf * 8), _block(nf * 8, nf * 8), _block(nf * 8, nf * 8)
        self.d8 = _block(nf * 8, nf * 8, bn=False)
        self.u1 = _block(nf * 8, nf * 8, down=False, drop=True)
        self.u2 = _block(nf * 16, nf * 8, down=False, drop=True)
        self.u3 = _block(nf * 16, nf * 8, down=False, drop=True)
        self.u4 = _block(nf * 16, nf * 8, down=False)
        self.u5 = _block(nf * 16, nf * 4, down=False)
        self.u6 = _block(nf * 8, nf * 2, down=False)
        self.u7 = _block(nf * 4, nf, down=False)
        self.u8 = nn.Sequential(nn.ConvTranspose2d(nf * 2, oc, 4, 2, 1), nn.Tanh())

    def forward(self, x):
        d1 = self.d1(x); d2 = self.d2(d1); d3 = self.d3(d2); d4 = self.d4(d3)
        d5 = self.d5(d4); d6 = self.d6(d5); d7 = self.d7(d6); d8 = self.d8(d7)
        u1 = self.u1(d8)
        u2 = self.u2(torch.cat([u1, d7], 1)); u3 = self.u3(torch.cat([u2, d6], 1))
        u4 = self.u4(torch.cat([u3, d5], 1)); u5 = self.u5(torch.cat([u4, d4], 1))
        u6 = self.u6(torch.cat([u5, d3], 1)); u7 = self.u7(torch.cat([u6, d2], 1))
        return self.u8(torch.cat([u7, d1], 1))


class PatchD(nn.Module):
    """70x70 PatchGAN over (SAR cond + RGB) = 7 channels."""

    def __init__(self, ic=7, nf=64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(ic, nf, 4, 2, 1), nn.LeakyReLU(0.2, True),
            _block(nf, nf * 2), _block(nf * 2, nf * 4),
            nn.Conv2d(nf * 4, nf * 8, 4, 1, 1), nn.BatchNorm2d(nf * 8), nn.LeakyReLU(0.2, True),
            nn.Conv2d(nf * 8, 1, 4, 1, 1),
        )

    def forward(self, sar, rgb):
        return self.net(torch.cat([sar, rgb], 1))


# ----------------------------- viz -----------------------------
def dump_samples(sar, fake, real, path):
    def den(t):
        return ((t.clamp(-1, 1) + 1) * 127.5).byte().cpu().numpy()
    s = den(sar[:4, 0:1].repeat(1, 3, 1, 1) if sar.ndim == 4 else sar)
    f, r = den(fake), den(real)
    rows = []
    for i in range(min(4, fake.shape[0])):
        sg = np.transpose(s[i], (1, 2, 0))
        fg = np.transpose(f[i], (1, 2, 0))
        rg = np.transpose(r[i], (1, 2, 0))
        rows.append(np.concatenate([sg, fg, rg], axis=1))
    Image.fromarray(np.concatenate(rows, axis=0)).save(path)


# ----------------------------- train -----------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="runs/colorizer")
    ap.add_argument("--epochs", type=int, default=200)
    ap.add_argument("--bs", type=int, default=10)
    ap.add_argument("--crop", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--l1", type=float, default=100.0)
    ap.add_argument("--sample_every", type=int, default=200)
    ap.add_argument("--ckpt_every", type=int, default=2000)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(os.path.join(a.out, "samples"), exist_ok=True)

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ds = SN6Pairs(a.data, crop=a.crop)
    print(f"device={dev} pairs={len(ds)} bs={a.bs} crop={a.crop}", flush=True)
    dl = DataLoader(ds, batch_size=a.bs, shuffle=True, num_workers=6, drop_last=True, pin_memory=True)

    G, D = UNetG().to(dev), PatchD().to(dev)
    optG = torch.optim.Adam(G.parameters(), lr=a.lr, betas=(0.5, 0.999))
    optD = torch.optim.Adam(D.parameters(), lr=a.lr, betas=(0.5, 0.999))
    l1 = nn.L1Loss()

    def gan(pred, target):  # LSGAN
        return ((pred - target) ** 2).mean()

    step = 0
    epochs = 1 if a.smoke else a.epochs
    for ep in range(epochs):
        for sar, rgb in dl:
            sar, rgb = sar.to(dev), rgb.to(dev)
            with torch.autocast(dev, dtype=torch.bfloat16):
                fake = G(sar)
                # D
                d_real = D(sar, rgb)
                d_fake = D(sar, fake.detach())
                lossD = 0.5 * (gan(d_real, torch.ones_like(d_real)) + gan(d_fake, torch.zeros_like(d_fake)))
            optD.zero_grad(set_to_none=True); lossD.backward(); optD.step()
            with torch.autocast(dev, dtype=torch.bfloat16):
                d_fake2 = D(sar, fake)
                lossG = gan(d_fake2, torch.ones_like(d_fake2)) + a.l1 * l1(fake, rgb)
            optG.zero_grad(set_to_none=True); lossG.backward(); optG.step()

            if step % 50 == 0:
                print(f"ep{ep} step{step} G={lossG.item():.3f} D={lossD.item():.3f} t={time.strftime('%H:%M:%S')}", flush=True)
            if step % a.sample_every == 0:
                with torch.no_grad():
                    dump_samples(sar.float(), fake.float(), rgb.float(),
                                 os.path.join(a.out, "samples", f"step_{step:07d}.png"))
            if step and step % a.ckpt_every == 0:
                torch.save({"G": G.state_dict(), "step": step}, os.path.join(a.out, "G_latest.pt"))
            step += 1
            if a.smoke and step >= 3:
                assert torch.isfinite(lossG) and torch.isfinite(lossD), "non-finite loss"
                dump_samples(sar.float(), fake.float(), rgb.float(), os.path.join(a.out, "samples", "smoke.png"))
                print("SMOKE_OK", flush=True)
                return
    torch.save({"G": G.state_dict(), "step": step}, os.path.join(a.out, "G_final.pt"))
    print("TRAIN_DONE", flush=True)


if __name__ == "__main__":
    main()
