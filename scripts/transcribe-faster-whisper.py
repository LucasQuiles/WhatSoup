#!/usr/bin/env python3
import argparse
import json
import signal
import sys

from faster_whisper import WhisperModel


def _exit_on_signal(_signum, _frame):
    raise SystemExit(1)


def main() -> int:
    signal.signal(signal.SIGTERM, _exit_on_signal)
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
    segments, _info = model.transcribe(
        args.input,
        vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 500},
    )
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    json.dump({'text': text}, sys.stdout)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
