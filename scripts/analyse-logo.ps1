# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 WulffTech

# one-off look at the source logo before deriving anything from it
Add-Type -AssemblyName System.Drawing

# resolved from the script rather than hardcoded, same as build-icons.ps1 — moving the
# repo shouldn't quietly break it
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "chat-tags.png"
$bmp = New-Object System.Drawing.Bitmap($src)
$w = $bmp.Width
$h = $bmp.Height

$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)
$stride = $data.Stride
$bmp.Dispose()

# the stray column, sampled well away from the artwork
"--- column 535, rows outside the face ---"
foreach ($y in 0, 3, 10, 300, 630, 639) {
	$i = $y * $stride + 535 * 4
	"  y=$y  a=$($bytes[$i+3]) r=$($bytes[$i+2]) g=$($bytes[$i+1]) b=$($bytes[$i])"
}

"--- neighbours at y=10 ---"
foreach ($x in 533, 534, 535, 536, 537) {
	$i = 10 * $stride + $x * 4
	"  x=$x  a=$($bytes[$i+3]) r=$($bytes[$i+2]) g=$($bytes[$i+1]) b=$($bytes[$i])"
}

# any other full-height columns, or full-width rows
$badCols = @()
for ($x = 0; $x -lt $w; $x++) {
	$opaque = 0
	for ($y = 0; $y -lt $h; $y++) { if ($bytes[$y * $stride + $x * 4 + 3] -ge 16) { $opaque++ } }
	if ($opaque -ge ($h - 2)) { $badCols += $x }
}
"--- full-height columns: $($badCols -join ', ')"

$badRows = @()
for ($y = 0; $y -lt $h; $y++) {
	$opaque = 0
	for ($x = 0; $x -lt $w; $x++) { if ($bytes[$y * $stride + $x * 4 + 3] -ge 16) { $opaque++ } }
	if ($opaque -ge ($w - 2)) { $badRows += $y }
}
"--- full-width rows: $($badRows -join ', ')"

# real artwork bounds, ignoring the stray column
$minX = $w; $maxX = -1; $minY = $h; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
	for ($x = 0; $x -lt $w; $x++) {
		if ($badCols -contains $x) { continue }
		if ($bytes[$y * $stride + $x * 4 + 3] -lt 16) { continue }
		if ($x -lt $minX) { $minX = $x }
		if ($x -gt $maxX) { $maxX = $x }
		if ($y -lt $minY) { $minY = $y }
		if ($y -gt $maxY) { $maxY = $y }
	}
}
"--- artwork bbox ignoring stray columns: x $minX..$maxX  y $minY..$maxY  ($(($maxX-$minX+1))x$(($maxY-$minY+1)))"
