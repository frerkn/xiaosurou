# Live2D 8192 -> 2048 texture resizer (zero dependency: PowerShell 5.1 + .NET built-in)
# Run: .\resize-live2d-texture.ps1
# Optional: .\resize-live2d-texture.ps1 -ModelDir "<abs path>" -MaxSize 2048

param(
    [string]$ModelDir = "",
    [int]$MaxSize = 2048
)

Add-Type -AssemblyName System.Drawing

# Auto-detect: find first dir under assets/live2d that contains a .model3.json
if ([string]::IsNullOrEmpty($ModelDir)) {
    $autoDetected = Get-ChildItem -Path "assets\live2d" -Recurse -Filter "*.model3.json" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($autoDetected) {
        $ModelDir = $autoDetected.DirectoryName
        Write-Host "[Auto-detected] Model dir: $ModelDir" -ForegroundColor Cyan
    } else {
        Write-Host "[ERROR] No .model3.json found under assets\live2d" -ForegroundColor Red
        Write-Host "Pass -ModelDir explicitly, e.g. -ModelDir 'C:\full\path\to\model'" -ForegroundColor Yellow
        exit 1
    }
}

if (!(Test-Path $ModelDir)) {
    Write-Host "[ERROR] Model dir not found: $ModelDir" -ForegroundColor Red
    exit 1
}

$backupDir = Join-Path $ModelDir "_8192_backup"
if (!(Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir | Out-Null
}

$pngs = Get-ChildItem -Path $ModelDir -Recurse -Filter "texture_*.png"
if ($pngs.Count -eq 0) {
    Write-Host "[ERROR] No texture_*.png found in $ModelDir" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Found $($pngs.Count) texture file(s), processing..." -ForegroundColor Cyan

foreach ($png in $pngs) {
    $relPath = $png.FullName.Substring((Resolve-Path $ModelDir).Path.Length)
    Write-Host ""
    Write-Host "Processing: $relPath" -ForegroundColor Yellow

    $backupPath = Join-Path $backupDir $relPath
    if (!(Test-Path $backupPath)) {
        $backupParent = Split-Path $backupPath -Parent
        if (!(Test-Path $backupParent)) { New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
        Copy-Item $png.FullName $backupPath
        Write-Host "  [OK] Backed up original" -ForegroundColor Gray
    }

    try {
        $img = [System.Drawing.Image]::FromFile($png.FullName)
    } catch {
        Write-Host "  [ERROR] Load failed: $_" -ForegroundColor Red
        continue
    }

    $origW = $img.Width
    $origH = $img.Height
    Write-Host "  Original: ${origW}x${origH}" -ForegroundColor Gray

    if ($origW -le $MaxSize -and $origH -le $MaxSize) {
        Write-Host "  -> Already <= $MaxSize, skip" -ForegroundColor Green
        $img.Dispose()
        continue
    }

    $ratio = [Math]::Min($MaxSize / $origW, $MaxSize / $origH)
    $newW = [int]($origW * $ratio)
    $newH = [int]($origH * $ratio)

    $bmp = New-Object System.Drawing.Bitmap($newW, $newH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($img, 0, 0, $newW, $newH)
    $g.Dispose()
    $img.Dispose()

    $tmpPath = "$($png.FullName).tmp"
    $bmp.Save($tmpPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Move-Item -Force $tmpPath $png.FullName

    $newSize = (Get-Item $png.FullName).Length
    Write-Host "  [OK] Resized to ${newW}x${newH}, size: $([math]::Round($newSize/1MB, 2)) MB" -ForegroundColor Green
}

$modelJsonPaths = Get-ChildItem -Path $ModelDir -Filter "*.model3.json" -Recurse
foreach ($json in $modelJsonPaths) {
    $content = Get-Content $json.FullName -Encoding UTF8 -Raw
    if ($content -match '\.8192') {
        Write-Host ""
        Write-Host "Note: $($json.Name) references .8192 path (we kept folder name, no change needed)" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Backups at: $backupDir" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: folder name kept as-is (still ends with .8192), model3.json path still works." -ForegroundColor Gray
