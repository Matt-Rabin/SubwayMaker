"""Build offline OpenMapTiles vector tiles for a city with Planetiler (needs Java 21+ and `pip install pmtiles`).

Full detail (z0-14) inside the census bbox plus a margin; around it only z0-10, enough for the horizon.
Output: data/tiles/<city>.pmtiles, used by js/render.js for cities listed in LOCAL_TILES.

Usage: python tools/build_tiles.py [cache_dir] [city ...]
"""
import math, os, subprocess, sys
from pmtiles.reader import Reader, MmapSource, all_tiles
from pmtiles.writer import Writer
from pmtiles.tile import zxy_to_tileid
from build_data import CITIES, fetch

PLANETILER = 'https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar'
# Geofabrik extract containing each bbox (Planetiler reads one OSM file)
AREA = {'bos': 'massachusetts', 'chi': 'illinois', 'sf': 'norcal', 'la': 'socal', 'sea': 'washington',
        'nyc': 'us-northeast', 'phl': 'us-northeast', 'pit': 'us-northeast', 'dc': 'us-south',
        'tor': 'ontario', 'mtl': 'quebec', 'van': 'british-columbia'}
DETAIL_PAD, CONTEXT_PAD, CONTEXT_Z = 0.05, 0.5, 10   # degrees around the bbox; max zoom outside the detail box


def lon2x(lon, z):
    return int((lon + 180) / 360 * 2 ** z)


def lat2y(lat, z):
    return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** z)


def build(cid, cache, out_dir):
    w, s, e, n = CITIES[cid]['bbox']
    full = os.path.join(cache, cid + '-full.pmtiles')
    if not os.path.exists(full):
        ctx = (w - CONTEXT_PAD, s - CONTEXT_PAD, e + CONTEXT_PAD, n + CONTEXT_PAD)
        subprocess.run(['java', '-Xmx8g', '-jar', fetch(PLANETILER, cache), '--download', f'--area={AREA[cid]}',
                        f'--download_dir={cache}', f'--tmpdir={os.path.join(cache, "tmp")}',
                        '--bounds=' + ','.join(map(str, ctx)), f'--output={full}', '--force'], check=True)
    d = (w - DETAIL_PAD, s - DETAIL_PAD, e + DETAIL_PAD, n + DETAIL_PAD)
    keep = lambda z, x, y: z <= CONTEXT_Z or (lon2x(d[0], z) <= x <= lon2x(d[2], z) and lat2y(d[3], z) <= y <= lat2y(d[1], z))
    os.makedirs(out_dir, exist_ok=True)
    out, kept, total = os.path.join(out_dir, cid + '.pmtiles'), 0, 0
    with open(full, 'rb') as f, open(out, 'wb') as o:
        r, wr = Reader(MmapSource(f)), Writer(o)
        for (z, x, y), data in all_tiles(r.get_bytes):
            total += 1
            if keep(z, x, y):
                wr.write_tile(zxy_to_tileid(z, x, y), data)
                kept += 1
        wr.finalize(r.header(), r.metadata())
    print(f'{cid}: kept {kept}/{total} tiles, {os.path.getsize(full) / 1e6:.1f} MB -> {os.path.getsize(out) / 1e6:.1f} MB', flush=True)


if __name__ == '__main__':
    cache = sys.argv[1] if len(sys.argv) > 1 else 'cache'
    os.makedirs(cache, exist_ok=True)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'tiles')
    for cid in sys.argv[2:] or AREA:
        build(cid, cache, out)
