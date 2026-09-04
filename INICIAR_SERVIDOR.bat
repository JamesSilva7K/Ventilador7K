@echo off
title Iniciando servidor de pagamento...
color 0A
echo.
echo  =====================================================
echo   SERVIDOR PHP - SISTEMA DE PAGAMENTO
echo  =====================================================
echo.

:: Tentar encontrar PHP automaticamente
set PHP_PATH=

:: XAMPP paths comuns
for %%P in (
    "C:\xampp\php\php.exe"
    "D:\xampp\php\php.exe"
    "C:\XAMPP\php\php.exe"
    "D:\XAMPP\php\php.exe"
    "C:\php\php.exe"
    "D:\php\php.exe"
    "C:\wamp64\bin\php\php8.2.0\php.exe"
    "C:\wamp64\bin\php\php8.1.0\php.exe"
    "C:\wamp\bin\php\php8.2.0\php.exe"
    "C:\laragon\bin\php\php8.2.3\php.exe"
    "C:\laragon\bin\php\php8.1.10\php.exe"
) do (
    if exist %%P (
        set PHP_PATH=%%P
        goto :found
    )
)

:: Tentar PATH do sistema
where php >nul 2>&1
if %errorlevel% == 0 (
    set PHP_PATH=php
    goto :found
)

echo  [ERRO] PHP nao encontrado automaticamente!
echo.
echo  Por favor, edite este arquivo e insira o caminho do PHP:
echo  Ex: set PHP_PATH=C:\xampp\php\php.exe
echo.
echo  Ou abra o XAMPP Control Panel e clique START no Apache,
echo  depois acesse: http://localhost/pagamento/
echo.
pause
exit /b 1

:found
echo  [OK] PHP encontrado: %PHP_PATH%
echo.

:: Verificar versao
%PHP_PATH% -r "echo 'PHP ' . PHP_VERSION . PHP_EOL;"
echo.

:: Iniciar servidor na porta 8080
echo  Iniciando servidor em http://localhost:8080
echo  Pasta: %~dp0pagamento\
echo.
echo  Pressione CTRL+C para parar o servidor.
echo  =====================================================
echo.

:: Abrir browser automaticamente apos 2 segundos
start "" /B timeout /t 2 /nobreak >nul 2>&1 && start "" "http://localhost:8080/index.php"

:: Iniciar PHP built-in server
%PHP_PATH% -S localhost:8080 -t "%~dp0pagamento"

echo.
echo  Servidor encerrado.
pause
