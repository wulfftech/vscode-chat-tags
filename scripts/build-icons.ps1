# derives every icon the project ships from the one source logo
#
# two things the source needs before anything else uses it:
#   - column 535 is a stray 25%-alpha purple line running the full 640px height, a
#     leftover guide from whatever drew it
#   - the activity bar renders its icon through -webkit-mask, so colour is thrown away
#     and only alpha survives. the full-colour logo would mask to a solid blob, so the
#     bar gets a version whose alpha traces the black linework and drops the gradient

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "chat-tags.png"
$media = Join-Path $root "media"
$dev = Join-Path $root "dev"

# where black stops and the gradient starts, in max(r,g,b). the span between them keeps
# the antialiasing instead of hard-cutting it
$BLACK_AT = 40
$COLOUR_AT = 110

function Get-Pixels($bitmap) {
	$rect = New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)
	$data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$bytes = New-Object byte[] ($data.Stride * $bitmap.Height)
	[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
	$bitmap.UnlockBits($data)
	return @{ bytes = $bytes; stride = $data.Stride }
}

function New-BitmapFrom($bytes, $stride, $w, $h) {
	$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
	$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
	$bmp.UnlockBits($data)
	return $bmp
}

function Resize-Bitmap($bitmap, $size) {
	$out = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$g = [System.Drawing.Graphics]::FromImage($out)
	$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
	$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
	$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
	# SourceCopy so edge pixels are not blended against the transparent black underneath
	$g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
	$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
	$g.DrawImage($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
	$g.Dispose()
	return $out
}

$bmp = New-Object System.Drawing.Bitmap($src)
$w = $bmp.Width
$h = $bmp.Height
$p = Get-Pixels $bmp
$bytes = $p.bytes
$stride = $p.stride
$bmp.Dispose()

# ── repair the stray column ───────────────────────────────
# every row gets the mean of its neighbours, which is right whether the row is artwork
# or the empty space above and below it
$STRAY = 535
for ($y = 0; $y -lt $h; $y++) {
	$i = $y * $stride + $STRAY * 4
	$l = $y * $stride + ($STRAY - 1) * 4
	$r = $y * $stride + ($STRAY + 1) * 4
	for ($c = 0; $c -lt 4; $c++) {
		$bytes[$i + $c] = [byte](([int]$bytes[$l + $c] + [int]$bytes[$r + $c]) / 2)
	}
}

$clean = New-BitmapFrom $bytes $stride $w $h
$logoPath = Join-Path $media "logo.png"
$clean.Save($logoPath, [System.Drawing.Imaging.ImageFormat]::Png)
"wrote $logoPath (${w}x${h}, stray column repaired)"

# ── marketplace icon ──────────────────────────────────────
$icon = Resize-Bitmap $clean 256
$iconPath = Join-Path $media "icon.png"
$icon.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()
"wrote $iconPath (256x256)"

# ── activity bar mask ─────────────────────────────────────
# alpha carries the black linework, colour is set to white so the file is legible on its
# own. the bar throws the colour away regardless
$mask = New-Object byte[] $bytes.Length
for ($y = 0; $y -lt $h; $y++) {
	for ($x = 0; $x -lt $w; $x++) {
		$i = $y * $stride + $x * 4
		$a = [int]$bytes[$i + 3]
		$max = [Math]::Max([int]$bytes[$i], [Math]::Max([int]$bytes[$i + 1], [int]$bytes[$i + 2]))
		if ($max -le $BLACK_AT) { $blackness = 1.0 }
		elseif ($max -ge $COLOUR_AT) { $blackness = 0.0 }
		else { $blackness = ($COLOUR_AT - $max) / ($COLOUR_AT - $BLACK_AT) }
		$mask[$i] = 255
		$mask[$i + 1] = 255
		$mask[$i + 2] = 255
		$mask[$i + 3] = [byte][Math]::Round($a * $blackness)
	}
}

$maskFull = New-BitmapFrom $mask $stride $w $h
$maskSmall = Resize-Bitmap $maskFull 128
$maskPath = Join-Path $media "activity.png"
$maskSmall.Save($maskPath, [System.Drawing.Imaging.ImageFormat]::Png)
"wrote $maskPath (128x128, alpha-only linework)"

# ── preview of what the bar will actually show ────────────
# the mask composited in white over the activity bar's own background, at the real
# 24px and blown up beside it, because 24px is too small to judge on screen
if (-not (Test-Path $dev)) { New-Item -ItemType Directory $dev | Out-Null }
$preview = New-Object System.Drawing.Bitmap(320, 140, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($preview)
$g.Clear([System.Drawing.Color]::FromArgb(255, 24, 24, 24))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($maskSmall, (New-Object System.Drawing.Rectangle(20, 58, 24, 24)))
$g.DrawImage($maskSmall, (New-Object System.Drawing.Rectangle(70, 46, 48, 48)))
$g.DrawImage($maskSmall, (New-Object System.Drawing.Rectangle(140, 6, 128, 128)))
$g.Dispose()
$previewPath = Join-Path $dev "activity-preview.png"
$preview.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()
"wrote $previewPath (24px, 48px, 128px on the bar background)"

$maskFull.Dispose()
$maskSmall.Dispose()
$clean.Dispose()
