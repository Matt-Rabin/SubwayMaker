"""Build real-city demand data from US Census sources.

Inputs (downloaded and cached):
  - US: Census 2020 block-group population centroids (CenPop2020_Mean_BG)
  - US: LEHD LODES8 origin-destination job flows (home block -> work block)
  - Canada: 2021 dissemination-area population (98-10-0015), jobs by census tract of work (98-10-0494),
    boundary centroids from StatCan's map server; flows estimated with a gravity model
Output: data/<city>.js with block groups [lon, lat, residents, jobs] and
commuter groups [homeBG, workBG, multiplier] sampled proportionally to flows.

Usage: python tools/build_data.py [cache_dir] [city ...]
"""
import csv, gzip, io, json, math, os, random, sys, time, urllib.error, urllib.parse, urllib.request, zipfile

CITIES = {
    'nyc': dict(name='New York', bbox=(-74.27, 40.49, -73.68, 40.92), states=['ny', 'nj'],
                airports=[('JFK Airport', -73.7781, 40.6413), ('LaGuardia Airport', -73.8740, 40.7769), ('Newark Airport', -74.1745, 40.6895)]),
    'chi': dict(name='Chicago', bbox=(-87.95, 41.64, -87.52, 42.07), states=['il'],
                airports=[("O'Hare Airport", -87.9073, 41.9742), ('Midway Airport', -87.7522, 41.7868)]),
    'sf': dict(name='San Francisco Bay', bbox=(-122.53, 37.60, -122.12, 37.90), states=['ca'],
               airports=[('SFO Airport', -122.3790, 37.6213), ('Oakland Airport', -122.2197, 37.7126)]),
    'la': dict(name='Los Angeles', bbox=(-118.62, 33.72, -118.10, 34.20), states=['ca'],
               airports=[('LAX Airport', -118.4085, 33.9416)]),
    'bos': dict(name='Boston', bbox=(-71.19, 42.27, -70.98, 42.43), states=['ma'],
                airports=[('Logan Airport', -71.0096, 42.3656)]),
    'sea': dict(name='Seattle', bbox=(-122.44, 47.43, -122.22, 47.74), states=['wa'],
                airports=[('SeaTac Airport', -122.3088, 47.4502)]),
    'phl': dict(name='Philadelphia', bbox=(-75.30, 39.86, -74.95, 40.14), states=['pa', 'nj'],
                airports=[('PHL Airport', -75.2424, 39.8744)]),
    'dc': dict(name='Washington DC', bbox=(-77.17, 38.79, -76.90, 39.00), states=['dc', 'md', 'va'],
               airports=[('Reagan National Airport', -77.0402, 38.8512)]),
    'pit': dict(name='Pittsburgh', bbox=(-80.26, 40.33, -79.84, 40.55), states=['pa'],
                airports=[('PIT Airport', -80.2329, 40.4915)]),
    # Canada: StatCan publishes no fine-grained home->work flows, so trips are estimated (see canada_flows)
    'tor': dict(name='Toronto', bbox=(-79.64, 43.58, -79.12, 43.86), canada=True,
                airports=[('Pearson Airport', -79.6248, 43.6777), ('Billy Bishop Airport', -79.3962, 43.6275)]),
    'mtl': dict(name='Montreal', bbox=(-73.98, 45.40, -73.47, 45.70), canada=True,
                airports=[('Trudeau Airport', -73.7408, 45.4706)]),
    'van': dict(name='Vancouver', bbox=(-123.27, 49.13, -122.88, 49.35), canada=True,
                airports=[('YVR Airport', -123.1844, 49.1967)]),
}
FIPS = {'ny': '36', 'nj': '34', 'il': '17', 'ca': '06', 'ma': '25', 'wa': '53', 'pa': '42', 'dc': '11', 'md': '24', 'va': '51'}
TARGET_GROUPS = 24000
STATCAN_GEO = 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/%d/query'
DECAY_M = 6000      # gravity-model distance decay for Canadian trips, m
EMP_RATE = 0.5      # commuters per resident, capped by jobs with a usual place of work


def fetch(url, cache):
    path = os.path.join(cache, url.rsplit('/', 1)[1])
    if not os.path.exists(path):
        print('  downloading', url, flush=True)
        tmp = path + '.part'
        with urllib.request.urlopen(url, timeout=600) as r, open(tmp, 'wb') as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        os.replace(tmp, path)
    return path


def od_file(st, part, cache):
    for year in (2022, 2021, 2020):
        url = f'https://lehd.ces.census.gov/data/lodes/LODES8/{st}/od/{st}_od_{part}_JT00_{year}.csv.gz'
        try:
            return fetch(url, cache)
        except Exception as e:
            print('   ', year, 'unavailable:', e)
    raise RuntimeError(f'no LODES {part} file for {st}')


def polygons(layer, bbox, cache, name):
    """{DGUID: rings} for StatCan boundary polygons (2021 DAs = 12, census tracts = 11) touching bbox."""
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        out, off = {}, 0
        while True:
            q = urllib.parse.urlencode(dict(where='1=1', geometry=','.join(map(str, bbox)), geometryType='esriGeometryEnvelope', inSR=4326,
                                            spatialRel='esriSpatialRelIntersects', outFields='DGUID', returnGeometry='true',
                                            maxAllowableOffset=0.0002, outSR=4326, f='json', resultOffset=off, resultRecordCount=500))
            for attempt in range(6):   # the map server throws sporadic 500s
                try:
                    with urllib.request.urlopen(STATCAN_GEO % layer + '?' + q, timeout=600) as r:
                        d = json.load(r)
                    break
                except urllib.error.HTTPError:
                    if attempt == 5:
                        raise
                    time.sleep(2 ** attempt)
            for f in d['features']:
                out[f['attributes']['DGUID']] = f['geometry']['rings']
            off += len(d['features'])
            if not d.get('exceededTransferLimit') and len(d['features']) < 500:
                break
        with open(path, 'w') as f:
            json.dump(out, f)
    with open(path) as f:
        return json.load(f)


def centroid(rings):
    a = sx = sy = 0.0   # shoelace over all rings; holes have opposite winding so they subtract
    for ring in rings:
        for (xa, ya), (xb, yb) in zip(ring, ring[1:]):
            k = xa * yb - xb * ya
            a += k; sx += (xa + xb) * k; sy += (ya + yb) * k
    return (round(sx / (3 * a), 5), round(sy / (3 * a), 5)) if a else None


def contains(rings, lon, lat):
    inside = False   # even-odd ray cast, so holes and multipart polygons work
    for ring in rings:
        for (xi, yi), (xj, yj) in zip(ring, ring[1:]):
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
    return inside


def statcan_table(pid, col, cache, keep):
    """{DGUID: value of column col} for the all-totals rows of a StatCan table, cached as JSON."""
    path = os.path.join(cache, f'{pid}-{col}.json')
    if not os.path.exists(path):
        out = {}
        with zipfile.ZipFile(fetch(f'https://www150.statcan.gc.ca/n1/tbl/csv/{pid}-eng.zip', cache)) as z, \
                z.open(f'{pid}.csv') as raw:
            r = csv.reader(io.TextIOWrapper(raw, encoding='utf-8-sig'))
            head = next(r)
            gi, ci, vi = head.index('DGUID'), head.index('Coordinate'), col
            for row in r:
                if len(row) > vi and keep(row[gi]) and set(row[ci].split('.')[1:]) <= {'1'}:
                    try:
                        out[row[gi]] = float(row[vi])
                    except ValueError:   # suppressed ('x', '..') or empty
                        pass
        with open(path, 'w') as f:
            json.dump(out, f)
    with open(path) as f:
        return json.load(f)


def canada_flows(c, cache, cid):
    """Real 2021 DA population and census-tract jobs; home->work trips from a production-constrained gravity model."""
    # ponytail: one decay constant for every city; calibrate DECAY_M to StatCan's CMA commute distances if trips look off
    x0, y0, x1, y1 = c['bbox']
    pop = statcan_table('98100015', 4, cache, lambda g: g[4:9] == 'S0512')     # DA population, 2021
    jobs = statcan_table('98100494', 12, cache, lambda g: g[4:9] == 'S0507')   # census tract of work, usual place of work
    kx, ky = 111320 * math.cos(math.radians((y0 + y1) / 2)), 110540
    bgs = [[lo, la, int(pop[g]), 0] for g, r in polygons(12, c['bbox'], cache, f'{cid}-da-poly.json').items()
           if pop.get(g) and (p := centroid(r)) and x0 <= (lo := p[0]) <= x1 and y0 <= (la := p[1]) <= y1]
    # a tract's jobs are spread evenly over its area, one point per 400 m game cell (js/city.js CELL), so job
    # density is jobs / tract area: one point per tract or per DA made big airport/industrial tracts outrank downtown
    # ponytail: uniform within a tract; weight cells by building floor space from the OSM tiles if hot spots look off
    dlon, dlat = 400 / kx, 400 / ky
    for g, rings in polygons(11, c['bbox'], cache, f'{cid}-ct-poly.json').items():
        if not jobs.get(g):
            continue
        xs, ys = [p[0] for r in rings for p in r], [p[1] for r in rings for p in r]
        cells = [(lo, la) for i in range(max(0, int((min(xs) - x0) / dlon)), int((min(max(xs), x1) - x0) / dlon) + 1)
                 for j in range(max(0, int((y1 - max(ys)) / dlat)), int((y1 - max(min(ys), y0)) / dlat) + 1)
                 if contains(rings, lo := x0 + (i + 0.5) * dlon, la := y1 - (j + 0.5) * dlat)]
        if not cells and (p := centroid(rings)) and x0 <= p[0] <= x1 and y0 <= p[1] <= y1:
            cells = [p]   # tract smaller than a cell
        for lo, la in cells:
            bgs.append([round(lo, 5), round(la, 5), 0, jobs[g] / len(cells)])
    bgs = [[lo, la, n, round(j)] for lo, la, n, j in bgs if n or j >= 1]
    total = min(sum(b[3] for b in bgs), EMP_RATE * sum(b[2] for b in bgs))
    share = total / sum(b[2] for b in bgs)
    dest = [(j, b[0] * kx, b[1] * ky, b[3]) for j, b in enumerate(bgs) if b[3]]

    def items():
        for h, b in enumerate(bgs):
            if not b[2]:
                continue
            hx, hy = b[0] * kx, b[1] * ky
            w = [(j, n * math.exp(-math.hypot(x - hx, y - hy) / DECAY_M)) for j, x, y, n in dest]
            s = sum(v for _, v in w)
            for j, v in w:
                yield (h, j), b[2] * share * v / s
    return bgs, items(), total


def us_flows(c, cache):
    x0, y0, x1, y1 = c['bbox']
    bgs, idx = [], {}
    for st in c['states']:
        p = fetch(f'https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG{FIPS[st]}.txt', cache)
        with open(p, encoding='utf-8-sig', errors='replace') as f:
            for row in csv.DictReader(f):
                lon, lat = float(row['LONGITUDE']), float(row['LATITUDE'])
                if x0 <= lon <= x1 and y0 <= lat <= y1:
                    g = row['STATEFP'] + row['COUNTYFP'] + row['TRACTCE'] + row['BLKGRPCE']
                    idx[g] = len(bgs)
                    bgs.append([round(lon, 5), round(lat, 5), int(row['POPULATION']), 0])
    pairs = {}
    for st in c['states']:
        for part in ('main', 'aux'):
            with gzip.open(od_file(st, part, cache), 'rt') as f:
                r = csv.reader(f)
                next(r)
                for row in r:
                    w = idx.get(row[0][:12])
                    if w is None:
                        continue
                    n = int(row[2])
                    bgs[w][3] += n
                    h = idx.get(row[1][:12])
                    if h is not None:
                        pairs[(h, w)] = pairs.get((h, w), 0) + n
    items = list(pairs.items())
    random.Random(42).shuffle(items)
    return bgs, items, sum(pairs.values())


def build(cid, cache, out_dir):
    c = CITIES[cid]
    print(cid, c['name'], flush=True)
    bgs, items, total = canada_flows(c, cache, cid) if c.get('canada') else us_flows(c, cache)
    unit = total / TARGET_GROUPS
    # systematic sampling proportional to flow: big flows become one group with a multiplier
    rnd = random.Random(42)
    acc, nxt, groups = 0.0, rnd.random() * unit, []
    for (h, w), n in items:
        acc += n
        k = 0
        while nxt < acc:
            k += 1
            nxt += unit
        if k:
            groups += [h, w, k]
    data = dict(id=cid, name=c['name'], bbox=c['bbox'], airports=[dict(name=a, lon=lo, lat=la) for a, lo, la in c['airports']],
                residents=sum(b[2] for b in bgs), commuters=round(total), unit=round(unit, 3),
                bgs=[v for b in bgs for v in b], groups=groups)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, cid + '.js'), 'w') as f:
        f.write('(window.CITY_DATA=window.CITY_DATA||{})[%s]=' % json.dumps(cid))
        json.dump(data, f, separators=(',', ':'))
        f.write(';\n')
    print(f'  {len(bgs)} zones, {round(total)} commuters, {len(groups) // 3} groups', flush=True)
    assert len(groups) // 3 > 1000 and total > 100000, 'suspiciously little data'


if __name__ == '__main__':
    cache = sys.argv[1] if len(sys.argv) > 1 else 'cache'
    os.makedirs(cache, exist_ok=True)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
    for cid in sys.argv[2:] or CITIES:
        build(cid, cache, out)
    with open(os.path.join(out, 'cities.js'), 'w') as f:
        f.write('window.CITY_LIST=%s;\n' % json.dumps([dict(id=k, name=v['name']) for k, v in CITIES.items()]))
