@echo off
rem build_msvc.bat — Configure and build with MSVC (Visual Studio)
rem Run from any directory; script locates itself automatically.

setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
set "SOURCE_DIR=%SCRIPT_DIR%..\.." 
set "BUILD_DIR=%SCRIPT_DIR%..\..\build_msvc"

echo [build_msvc] Configuring...
cmake -S "%SOURCE_DIR%" -B "%BUILD_DIR%" ^
    -G "Visual Studio 18 2026" -A x64 ^
    -DCMAKE_BUILD_TYPE=Debug ^
    -DWITH_OPENCV=ON ^
    -DWITH_EIGEN=ON

if errorlevel 1 (
    echo [build_msvc] CMake configure FAILED. Trying VS 2022...
    cmake -S "%SOURCE_DIR%" -B "%BUILD_DIR%" ^
        -G "Visual Studio 17 2022" -A x64 ^
        -DCMAKE_BUILD_TYPE=Debug ^
        -DWITH_OPENCV=ON ^
        -DWITH_EIGEN=ON
)

if errorlevel 1 (
    echo [build_msvc] Configure failed. Make sure Visual Studio is installed.
    exit /b 1
)

echo [build_msvc] Building...
cmake --build "%BUILD_DIR%" --config Debug --parallel

if errorlevel 1 (
    echo [build_msvc] Build FAILED.
    exit /b 1
)

echo [build_msvc] SUCCESS  ->  %BUILD_DIR%\Debug\demo.exe
