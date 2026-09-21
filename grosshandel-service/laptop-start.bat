@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================================
echo  WWS - Browser-Dienst und Agent starten
echo ==========================================================
echo.
echo  Dieser Rechner macht ab jetzt nur noch eines: er fragt bei
echo  der Hetzner-Box nach Browser-Auftraegen und arbeitet sie ab.
echo  Der Bot selbst laeuft auf der Box.
echo.
echo  Zwei Fenster gehen gleich auf. Beide muessen offen bleiben.
echo.
if not exist ".env" (
  echo  FEHLER: .env fehlt. Kopiere .env.example nach .env und
  echo  trage AUFTRAGSSTELLE_URL und AGENT_TOKEN ein.
  pause
  exit /b 1
)
start "WWS Browser-Dienst" cmd /k "cd /d %~dp0 && dienst-schleife.bat"
timeout /t 4 >nul
start "WWS Agent" cmd /k "cd /d %~dp0 && agent-schleife.bat"
echo  Gestartet. Dieses Fenster kann zu.
timeout /t 3 >nul
