"""Read-only comparison; exports hashes and aggregate counts, never request bodies."""
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('early', type=Path, help='Earlier project directory')
parser.add_argument('later', type=Path, help='Later project directory')
parser.add_argument('--early-source', type=Path, help='Original code backup if the earlier project was updated')
parser.add_argument('--output', type=Path, required=True, help='New summary file; existing files are not overwritten')
args = parser.parse_args()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_snapshot(project):
    root = project / 'data/logs/facepunch'
    if not root.is_dir():
        raise SystemExit('Facepunch log directory is missing')
    files, accounts, bodies = {}, {}, Counter()
    for path in sorted(root.rglob('*.jsonl')):
        if path.is_symlink():
            raise SystemExit('File links are not supported')
        with path.open('rb') as stream:
            raw = stream.read(os.fstat(stream.fileno()).st_size)
        tag = digest(path.relative_to(root).as_posix().encode())[:12]
        files[tag] = {'raw': raw, 'bytes': len(raw), 'sha256': digest(raw), 'malformedLines': 0}
        for line in raw.splitlines():
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                files[tag]['malformedLines'] += 1
                continue
            label = digest(str(row.get('accountId', 'unknown')).encode())[:10]
            account = accounts.setdefault(label, {'events': Counter(), 'httpStatuses': Counter(), 'bodyEventTypes': Counter()})
            event = row.get('event', 'unknown')
            account['events'][event] += 1
            if event == 'http_response':
                account['httpStatuses'][str(row.get('status'))] += 1
                bodies[str(row.get('capturedBytes'))] += 1
            if event == 'http_request' and isinstance(row.get('body'), list):
                for item in row['body']:
                    data = item.get('Data') if isinstance(item, dict) else None
                    if isinstance(data, dict):
                        account['bodyEventTypes'][str(data.get('type', 'unknown'))] += 1
    return {'files': files, 'accounts': accounts, 'responseBodyByteCounts': bodies}


early, later = read_snapshot(args.early), read_snapshot(args.later)
prefixes = [{'fileTag': tag, 'identicalPrefix': tag in later['files'] and later['files'][tag]['raw'].startswith(value['raw'])}
            for tag, value in early['files'].items()]
sources = []
for folder in ['src', 'plugin']:
    for path in sorted(((args.early_source or args.early) / folder).rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(args.early_source or args.early)
        other = args.later / relative
        sources.append({'file': relative.as_posix(), 'identical': other.is_file() and digest(path.read_bytes()) == digest(other.read_bytes())})
for snapshot in (early, later):
    for value in snapshot['files'].values():
        del value['raw']
result = {'createdAt': datetime.now(timezone.utc).isoformat(), 'early': early, 'later': later,
          'prefixes': prefixes, 'originalSources': sources}
args.output.parent.mkdir(parents=True, exist_ok=True)
with args.output.open('x', encoding='utf-8') as stream:
    json.dump(result, stream, ensure_ascii=False, indent=2)
    stream.write('\n')
print('Summary saved; raw request and response bodies were not exported.')
