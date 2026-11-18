@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Prefer the local conda base, then python on PATH.
if exist "E:\miniconda\python.exe" goto run_conda

python -c "import sys" >nul 2>nul
if not errorlevel 1 goto run_python

echo.
echo [pitch-scope] Python 3.9+ was not found.
echo Install Python, or run manually: python tools\serve.py
echo.
pause
exit /b 1

:run_python
python "tools\serve.py" %*
goto end

:run_conda
"E:\miniconda\python.exe" "tools\serve.py" %*
goto end

:end
endlocal
