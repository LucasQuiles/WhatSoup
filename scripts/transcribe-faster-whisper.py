#!/usr/bin/env python3
import argparse
import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--model', default='large-v3-turbo')
    parser.add_argument('--model-dir', required=True)
    args = parser.parse_args()

    model = WhisperModel(
        args.model,
        device='auto',
        compute_type='auto',
        download_root=args.model_dir,
    )
    segments, _info = model.transcribe(args.input)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    json.dump({'text': text}, sys.stdout)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
