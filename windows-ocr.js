// Offline Windows Built-in OCR (Windows.Media.Ocr) for Delshiv AI.
// Extracts text from any image file or directly from the current screen without internet.
import fs from "fs";
import os from "os";
import path from "path";
import { isProtectedPath } from "./safety-guard.js";
import { runPowerShell } from "./shared-utils.js";

export async function extractTextFromImage({ filePath = "", resolvePath = null } = {}) {
  let targetPath = String(filePath || "").trim();
  let isTemp = false;

  if (targetPath) {
    targetPath = typeof resolvePath === "function" ? resolvePath(targetPath) : path.resolve(targetPath);
    if (isProtectedPath(targetPath)) throw new Error(`Refusing to read protected location: ${targetPath}`);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) throw new Error(`Image file not found: ${targetPath}`);
  } else {
    targetPath = path.join(os.tmpdir(), `delshiv_ocr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
    isTemp = true;
    const safeOut = targetPath.replace(/'/g, "''");
    const capturePs = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DelshivDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DelshivDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save('${safeOut}', [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}`;
    await runPowerShell(capturePs, { timeout: 15000 });
  }

  try {
    const safeImg = targetPath.replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$stream = $null
$bitmap = $null
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${safeImg}')) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'Windows OCR language pack is unavailable.' }
  $ocrResult = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $ocrResult.Text
} finally {
  if ($bitmap) { $bitmap.Dispose() }
  if ($stream) { $stream.Dispose() }
}`;

    const text = await runPowerShell(ps, { timeout: 20000 });
    return {
      ok: true,
      source: isTemp ? "Primary Screen" : targetPath,
      text: text || "",
      message: text ? `Extracted ${text.length} character(s) via Windows OCR.` : "No readable text detected in image.",
    };
  } finally {
    if (isTemp) {
      try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch { /* ignore */ }
    }
  }
}
