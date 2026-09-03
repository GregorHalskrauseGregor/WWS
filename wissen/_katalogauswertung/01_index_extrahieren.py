import re,glob,os,json,collections
pat=re.compile(r'^(.+?)\.{3,}\s*([A-Z])\s*(\d+)\s*$')
out={}
for f in sorted(glob.glob('GC_*.txt'))+sorted(glob.glob('RF_*.txt')):
    name=os.path.basename(f)[:-4]
    ents=[]
    for line in open(f,encoding='utf-8',errors='replace'):
        m=pat.match(line.strip())
        if m:
            ents.append((m.group(1).strip(),m.group(2),int(m.group(3))))
    if ents: out[name]=ents
tot=0
for k,v in out.items():
    print(f'{k:28s} {len(v):6d} Index-Eintraege')
    tot+=len(v)
print('GESAMT',tot)
json.dump({k:v for k,v in out.items()},open('/tmp/index.json','w'),ensure_ascii=False)
