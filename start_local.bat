@echo off
title Website Checker - Auto Run

cd /d "%~dp0\checker"

:loop
cls
echo "========================================="
echo "   Website Checker - Running Loop"
echo "   Time: %TIME%"
echo "========================================="
echo.

set SHOW_BROWSER=false
call node index.js

echo.
echo "========================================="
echo "   Check Finished."
echo "   Waiting 1 minute before next run..."
echo "========================================="

timeout /t 60 >nul

goto loop
