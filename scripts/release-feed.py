import argparse
import base64
import datetime
import hashlib
import json
import re
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--android-code", type=int, required=True)
    parser.add_argument("--dist", type=Path, default=Path("dist"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]{1,5}[.][0-9]{1,5}[.][0-9]{1,5}", args.version) or args.android_code < 1:
        parser.error("Invalid version")

    key = serialization.load_pem_private_key(args.key.read_bytes(), password=None)
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    expected = Path(__file__).resolve().parent.parent / "app" / "update-public.pem"
    if public.splitlines() != expected.read_bytes().splitlines():
        parser.error("Signing key does not match the key bundled in the clients")
    artifacts = {}
    for platform, suffix in (("android", "Android.apk"), ("windows", "Windows-x64.exe")):
        file = args.dist / f"ShareSub-{args.version}-{suffix}"
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        artifacts[platform] = {
            "url": f"https://app.sharesub.ru/releases/{file.name}",
            "sha256": digest,
            "size": file.stat().st_size,
        }
    release = {
        "version": args.version,
        "androidCode": args.android_code,
        "publishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "artifacts": artifacts,
    }
    payload = json.dumps(release, separators=(",", ":"), sort_keys=True).encode()
    signature = key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
    envelope = {
        **release,
        "payload": base64.b64encode(payload).decode(),
        "signature": base64.b64encode(signature).decode(),
    }
    args.output.write_text(json.dumps(envelope, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
