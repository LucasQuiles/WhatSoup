#!/usr/bin/env python3
import argparse
import json
import signal
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def _exit_on_signal(_signum, _frame):
    raise SystemExit(1)


def main() -> int:
    signal.signal(signal.SIGTERM, _exit_on_signal)
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--model')
    parser.add_argument('--model-dir', required=True)
    args = parser.parse_args()

    model_path = args.model
    if model_path in (None, 'large-v3-turbo'):
        model_path = str(Path(args.model_dir) / 'large-v3-turbo-0c94664816ec82be77b20e824c8e8675995b0029')
    elif not Path(model_path).is_absolute():
        parser.error('--model must be large-v3-turbo or an absolute local model directory')
    required_files = ('config.json', 'model.bin', 'tokenizer.json')
    missing = [name for name in required_files if not (Path(model_path) / name).is_file()]
    if not (Path(model_path) / 'vocabulary.json').is_file() and not (Path(model_path) / 'vocabulary.txt').is_file():
        missing.append('vocabulary.json or vocabulary.txt')
    if missing:
        parser.error(f"local model is incomplete: {', '.join(missing)}")

    model = WhisperModel(
        model_path,
        device='auto',
        compute_type='auto',
        download_root=args.model_dir,
        local_files_only=True,
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
