"""AES-CBC URL signing for Apple Maps tile requests."""

import base64
import hashlib
import secrets
import string
import struct
import time
from urllib.parse import urlparse, quote

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


_CHARS = string.ascii_letters + string.digits
_IV = b"\x00" * 16


def _pkcs7_pad(data: bytes) -> bytes:
    pad_len = 16 - (len(data) % 16)
    return data + bytes([pad_len] * pad_len)


def sign_url(url: str, sid: str, token_p1: str, token_p2: str) -> str:
    parsed = urlparse(url)
    token_p3 = "".join(secrets.choice(_CHARS) for _ in range(16))
    key = hashlib.sha256((token_p1 + token_p2 + token_p3).encode()).digest()
    ts = int(time.time()) + 4200
    path = parsed.path
    if parsed.query:
        path += "?" + parsed.query
    sep = "&" if "?" in url else "?"
    plaintext = f"{path}{sep}sid={sid}{ts}{token_p3}".encode()
    cipher = Cipher(algorithms.AES(key), modes.CBC(_IV))
    enc = cipher.encryptor()
    ct = enc.update(_pkcs7_pad(plaintext)) + enc.finalize()
    access_key = f"{ts}_{token_p3}_{base64.b64encode(ct).decode()}"
    return f"{url}{sep}sid={sid}&accessKey={quote(access_key)}"
