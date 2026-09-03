import json,collections,re
d=json.load(open('/tmp/index.json'))
# Marken/Serien aus den Indizes: Woerter, die in VIELEN verschiedenen Kapiteln als Kopfwort auftauchen
# oder bekannt sind -> Marke, nicht Artikeltyp.
marken=set('''Geberit Viega REHAU Uponor CONEL COSMO VIGOUR TRINNITY KEMPER Grohe Hansa Kludi KWC Keuco Gessi Nobili
Villeroy Duravit LAUFEN Ideal Jacob Globo TOTO Kaldewei Bette Hoesch Knief Koralle Novellini Nuovvo Romay Kermi Roth
Sanipa Schneider Emco Inda HEWI NORMBAU Pressalit Schell Conti Ophardt CWS Wagner Meiko EWAR Rodan Dallmer Kessel ACO
LORO TECE Mepa Mabo Gampper Bemis Hamberger Stiebel Bosch CLAGE Vaillant Devi Brötje Remeha NOVELAN NIBE Dimplex SAMSUNG
LUVAQ BLW ETA Fröling NMT GEOplast Reflex Pneumatex Flamco Zeparo Arbonia Vonaris Heimeier Danfoss Oventrop Resideo Hummel
KSB Magra Sinus ARI BOA Grundfos Vortex Wilo CEMO Schütz Dehoust Maxitrol Keller Kirchner GOK Siemens ESBE Sanipex
FRÄNKISCHE Beulco PLASSON Raufoss Gebo Wieland Oyster Victaulic WALRAVEN Fischer Raychem Missel ROCKWOOL HEM CARE BCG
ASPEN Repa WEICON Allmess Seppelfricke SYR DOYMA ZAPP-ZIMMERMANN Kolektor Conlit PAM Vallox LUNOS Komfovent Helios Maico
Airflow Rosenberg TROX SCHAKO Strulik Aldes Kampmann Mark Remko Nordluft Tanner Walpol Exhausto Schulte DEC Upmann
Aerotechnik Belimo WIKA Hekatron Alre-IT Gripple REMKO Aermec Swegon Cordivari AirBlue Fieldpiece K-FLEX Walraven Aspen
Calpeda Sauermann DAB WILO Jung SULZER Judo BWT Cillit Grünbeck Caleffi UWS Sanibroy FLOW Kemper Conex|Bänninger
StrengThin Nikles ESS Langenberger Diermeyer OekoSolve CONAR LASA Lapesa Tuxhorn VAU BRUGG WATTS YADOS A.B.S. HVG
Easy DRAIN KLICK BIS VIS Prevista Mapress Sanpress Prestabo Profipress Temponox SteelPRES Megapress Raupiano SML KML
PP2000 aduxa Smatrix Siccus RemaSol SolarPlan Reflexomat Grohtherm Eurosmart Euroeco CeraPlus CeraFlex CeraLook CeraPlan
LINUS XERIS Cavere Bambini Renova OSA Edition PureLine Inox Nylon Modulo R-line M-line Linearis Diamond Nano Compact
Clean Condiline KaCool AIRISE Wind-Free NASA ValloFlex KWL Verso-CF Verso-R Verso-S AIR1 DUPLEXbase Silvento Limodor
Ventomaxx APART Curaflex Quadro-Secura FST KaRo ZZ® Serie System Design Plan Ventil Bad Kinder Spiel Zubehör Elektro
Technische Allgemeines Verwendung Oberfläche Abwasser Solar Press Therm Connect Membran Anoden HEAT INOX COPPER CONNECT
RAUTITAN Mepla RAL SANCO WICU Kälte T-Plus Gips STREAM LegioStop Brandschutz Barrierefreie Warm Standard STANDARD
Waschtisch Deckenkassetten Decken TOP Rahmenkollektoren Wannenkollektoren FKR NMC RMB/ENERGIE BGB Tank Tanks EMS
Flachkollektoren Solaranlagen Ecoflex CALPEX Regudis Aqua Hydraulische Geregelte 160er WRG Kontrollierte Commercial
Flexible Verzinkte Edelstahl Kunststoff Ovale AQA Geno-mat Soladur DRAG’EAU CLEAR'''.split())
shk=['GC_Installation','GC_Heizung','GC_Sanitaer_1','GC_Lueftung_1','GC_Klima','GC_Wasserwelt']
kap=collections.defaultdict(collections.Counter)
for k in shk:
    for begriff,kapitel,seite in d.get(k,[]):
        w=begriff.split()[0].strip(',/-()')
        if len(w)<4 or w[0].islower() or w in marken: continue
        kap[(k,kapitel)][w]+=1
for (k,c),cnt in sorted(kap.items()):
    top=[w for w,n in cnt.most_common(22)]
    print(f'--- {k} {c}\n    ' + ', '.join(top))
