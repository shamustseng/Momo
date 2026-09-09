<#
  Lark 雲空間 → 本機資料夾

  把 Lark 上「訂單」與「出貨」兩個共用資料夾的檔案抓到本機，
  再把抓下來的兩個資料夾拖進 order-check.html 做每日核對。

  需求：Windows 內建的 PowerShell 就夠，不用安裝任何東西。
  用法：
      第一次      .\lark-sync.ps1 -Test     只連線並列出看得到的檔案，不下載
      每天        雙擊 lark-sync.bat        或執行 .\lark-sync.ps1
#>
[CmdletBinding()]
param(
  [switch]$Test,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
try { $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch { }

function Write-Step($msg) { Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Bad($msg)  { Write-Host "  $msg" -ForegroundColor Red }

# ---------- 設定 ----------
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $ConfigPath) { $ConfigPath = Join-Path $here 'lark-sync.config.json' }

if (-not (Test-Path $ConfigPath)) {
  $template = [ordered]@{
    domain                  = 'lark'
    appId                   = 'cli_xxxxxxxxxxxxxxxx'
    appSecret               = '請填入應用的 App Secret'
    ordersFolderToken       = '訂單資料夾的 token'
    shipsFolderToken        = '出貨資料夾的 token'
    outputRoot              = 'C:\出貨核對'
    onlyModifiedWithinDays  = 2
    includeSubfolders       = $true
    exportLarkDocs          = $true
  }
  $json = $template | ConvertTo-Json
  [IO.File]::WriteAllText($ConfigPath, $json, [Text.UTF8Encoding]::new($true))
  Write-Host ''
  Write-Bad "找不到設定檔，已幫你建立一份範本："
  Write-Host "  $ConfigPath"
  Write-Host ''
  Write-Host '請打開它填入下列四項，再重新執行：'
  Write-Host '  appId / appSecret     Lark 開放平台「自建應用」的憑證'
  Write-Host '  ordersFolderToken     訂單資料夾網址最後那一段'
  Write-Host '  shipsFolderToken      出貨資料夾網址最後那一段'
  Write-Host ''
  Write-Host '資料夾 token 怎麼看：在 Lark 打開該資料夾，網址長這樣'
  Write-Host '  https://xxx.larksuite.com/drive/folder/fldcnAbCdEfGhIjKlMn'
  Write-Host '  最後的 fldcnAbCdEfGhIjKlMn 就是 token。'
  exit 1
}

try {
  $cfg = [IO.File]::ReadAllText($ConfigPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
} catch {
  Write-Bad "設定檔不是有效的 JSON：$ConfigPath"
  Write-Bad $_.Exception.Message
  exit 1
}

if ($cfg.domain -and $cfg.domain -like 'http*') { $base = $cfg.domain.TrimEnd('/') }
elseif ($cfg.domain -eq 'feishu')               { $base = 'https://open.feishu.cn' }
else                                            { $base = 'https://open.larksuite.com' }

foreach ($k in @('appId','appSecret','ordersFolderToken','shipsFolderToken')) {
  if (-not $cfg.$k -or "$($cfg.$k)".Trim() -eq '') { Write-Bad "設定檔缺少 $k"; exit 1 }
}
$outputRoot = if ($cfg.outputRoot) { $cfg.outputRoot } else { Join-Path $here 'out' }
$withinDays = if ($null -ne $cfg.onlyModifiedWithinDays) { [int]$cfg.onlyModifiedWithinDays } else { 0 }
$recurse    = -not ($cfg.includeSubfolders -eq $false)
$doExport   = -not ($cfg.exportLarkDocs -eq $false)

# ---------- HTTP ----------
function Invoke-Lark($Method, $Path, $Body) {
  $uri = "$base$Path"
  $headers = @{ Authorization = "Bearer $script:token" }
  try {
    if ($Body) {
      return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $Body `
             -ContentType 'application/json; charset=utf-8' -UseBasicParsing
    }
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -UseBasicParsing
  } catch {
    $detail = ''
    try {
      $resp = $_.Exception.Response
      if ($resp) {
        $reader = New-Object IO.StreamReader($resp.GetResponseStream())
        $detail = $reader.ReadToEnd()
      }
    } catch { }
    throw "呼叫 $Path 失敗：$($_.Exception.Message) $detail"
  }
}
function Assert-LarkOk($resp, $what) {
  if ($null -eq $resp.code) { return }
  if ($resp.code -eq 0) { return }
  $hint = ''
  if ($resp.code -eq 99991663 -or $resp.code -eq 99991661 -or "$($resp.msg)" -match 'access denied|permission|no permission') {
    $hint = "`n  多半是應用沒有這個資料夾的權限。請到 Lark 打開該資料夾 → 分享／協作者 → 把你的自建應用加進去（可讀即可）。"
  }
  throw "$what 失敗（code $($resp.code)）：$($resp.msg)$hint"
}

# ---------- 取得 token ----------
Write-Step '向 Lark 取得存取權杖'
$authBody = @{ app_id = $cfg.appId; app_secret = $cfg.appSecret } | ConvertTo-Json
try {
  $auth = Invoke-RestMethod -Method Post -Uri "$base/open-apis/auth/v3/tenant_access_token/internal" `
          -Body $authBody -ContentType 'application/json; charset=utf-8' -UseBasicParsing
} catch {
  Write-Bad "連不上 Lark：$($_.Exception.Message)"
  Write-Bad "請確認網路，以及設定檔的 domain（國際版填 lark，中國版填 feishu）。"
  exit 1
}
if ($auth.code -ne 0) {
  Write-Bad "取得權杖失敗（code $($auth.code)）：$($auth.msg)"
  Write-Bad "請確認 appId 與 appSecret 是否正確、應用是否已啟用。"
  exit 1
}
$script:token = $auth.tenant_access_token
Write-Ok '權杖取得成功'

# ---------- 列出資料夾 ----------
function Get-FolderItems($folderToken) {
  $all = @(); $pageToken = $null
  do {
    $q = "?page_size=200&folder_token=$([uri]::EscapeDataString($folderToken))"
    if ($pageToken) { $q += "&page_token=$([uri]::EscapeDataString($pageToken))" }
    $resp = Invoke-Lark 'Get' "/open-apis/drive/v1/files$q"
    Assert-LarkOk $resp '列出資料夾'
    if ($resp.data.files) { $all += $resp.data.files }
    $pageToken = $resp.data.next_page_token
    $more = [bool]$resp.data.has_more
  } while ($more -and $pageToken)
  return $all
}
function Get-AllFiles($folderToken, $depth) {
  $out = @()
  foreach ($f in (Get-FolderItems $folderToken)) {
    $type = "$($f.type)"
    if ($type -eq 'shortcut' -and $f.shortcut_info) {
      $type = "$($f.shortcut_info.target_type)"
      $f | Add-Member -NotePropertyName token -NotePropertyValue $f.shortcut_info.target_token -Force
      $f | Add-Member -NotePropertyName type  -NotePropertyValue $type -Force
    }
    if ($type -eq 'folder') {
      if ($recurse -and $depth -lt 5) { $out += Get-AllFiles $f.token ($depth + 1) }
      continue
    }
    $out += $f
  }
  return $out
}

# ---------- 下載 ----------
# 固定用 Windows 的非法字元集，不要用 [IO.Path]::GetInvalidFileNameChars()：
# 那個會隨作業系統改變（Linux 不把 : 當非法），行為就不一致了。
$script:BadNameChars = @('<','>',':','"','/','\','|','?','*')
function Get-SafeName($name) {
  $sb = New-Object Text.StringBuilder
  foreach ($ch in "$name".ToCharArray()) {
    if (($script:BadNameChars -contains $ch) -or ([int]$ch -lt 32)) { [void]$sb.Append('_') }
    else { [void]$sb.Append($ch) }
  }
  $s = $sb.ToString().Trim().TrimEnd('.')
  if ($s -eq '') { $s = 'file' }
  return $s
}
function Get-UniquePath($dir, $name) {
  $path = Join-Path $dir $name
  if (-not (Test-Path $path)) { return $path }
  $stem = [IO.Path]::GetFileNameWithoutExtension($name)
  $ext  = [IO.Path]::GetExtension($name)
  for ($i = 2; $i -lt 500; $i++) {
    $p = Join-Path $dir ("$stem($i)$ext")
    if (-not (Test-Path $p)) { return $p }
  }
  return Join-Path $dir ("$stem(" + [guid]::NewGuid().ToString('N').Substring(0,6) + ")$ext")
}
function Get-DownloadError($err) {
  $msg = $err.Exception.Message
  $code = ''
  try { $code = [int]$err.Exception.Response.StatusCode } catch { }
  if ($code -eq 403 -or $code -eq 401) {
    return "$msg（沒有這個檔案的權限：請把應用加入該資料夾的協作者）"
  }
  return $msg
}
function Save-Binary($path, $url) {
  Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $script:token" } `
    -OutFile $path -UseBasicParsing | Out-Null
}
# 清單裡的名稱有時沒有副檔名。核對工具是看副檔名決定怎麼解析的，
# 少了副檔名整個檔案會被當成不支援而略過，所以改從回應標頭補回來。
function Save-BinaryNamed($dir, $fallbackName, $url) {
  $resp = Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $script:token" } -UseBasicParsing
  $name = $fallbackName
  if ([IO.Path]::GetExtension($name) -eq '') {
    $cd = $null
    try { $cd = $resp.Headers['Content-Disposition'] } catch { }
    if ($cd) {
      $m = [regex]::Match("$cd", 'filename[^=]*=\s*"?([^";]+)')
      if ($m.Success) {
        $fromHeader = $m.Groups[1].Value.Trim()
        $fromHeader = $fromHeader -replace "^UTF-8''", ''
        try { $fromHeader = [uri]::UnescapeDataString($fromHeader) } catch { }
        $ext = [IO.Path]::GetExtension($fromHeader)
        if ($ext -ne '') { $name = "$name$ext" }
      }
    }
  }
  $path = Get-UniquePath $dir (Get-SafeName $name)
  $bytes = $resp.Content
  if ($bytes -is [string]) { $bytes = [Text.Encoding]::UTF8.GetBytes($bytes) }
  [IO.File]::WriteAllBytes($path, $bytes)
  return $path
}
function Save-PlainFile($file, $dir) {
  $name = Get-SafeName $file.name
  $url = "$base/open-apis/drive/v1/files/$($file.token)/download"
  if ([IO.Path]::GetExtension($name) -eq '') { return Save-BinaryNamed $dir $name $url }
  $path = Get-UniquePath $dir $name
  Save-Binary $path $url
  return $path
}
# 雲文件（Lark 自己的文件／表格）不能直接下載，要先建匯出任務再抓產物
function Save-LarkDoc($file, $dir) {
  $ext = $null
  switch ("$($file.type)") {
    'docx'    { $ext = 'docx' }
    'doc'     { $ext = 'docx' }
    'sheet'   { $ext = 'xlsx' }
    'bitable' { $ext = 'xlsx' }
  }
  if (-not $ext) { return $null }
  $body = @{ file_extension = $ext; token = $file.token; type = "$($file.type)" } | ConvertTo-Json
  $create = Invoke-Lark 'Post' '/open-apis/drive/v1/export_tasks' $body
  Assert-LarkOk $create '建立匯出任務'
  $ticket = $create.data.ticket
  $result = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 700
    $q = "/open-apis/drive/v1/export_tasks/$([uri]::EscapeDataString($ticket))?token=$([uri]::EscapeDataString($file.token))"
    $stat = Invoke-Lark 'Get' $q
    Assert-LarkOk $stat '查詢匯出任務'
    $job = $stat.data.result
    if ($null -eq $job) { continue }
    if ([int]$job.job_status -eq 0) { $result = $job; break }
    if ([int]$job.job_status -gt 1 -and [int]$job.job_status -ne 2) {
      throw "匯出失敗（status $($job.job_status)）：$($job.job_error_msg)"
    }
  }
  if (-not $result) { throw '匯出逾時' }
  $name = Get-SafeName $result.file_name
  if ([IO.Path]::GetExtension($name) -eq '') { $name = "$name.$($result.file_extension)" }
  $path = Get-UniquePath $dir $name
  Save-Binary $path "$base/open-apis/drive/v1/export_tasks/file/$($result.file_token)/download"
  return $path
}

# ---------- 同步一側 ----------
$cutoff = if ($withinDays -gt 0) { (Get-Date).AddDays(-$withinDays) } else { $null }

function Sync-Side($label, $folderToken, $dir) {
  Write-Step "$label：讀取 Lark 資料夾清單"
  $files = Get-AllFiles $folderToken 0
  Write-Ok "資料夾裡共 $($files.Count) 個檔案"

  if ($cutoff) {
    $before = $files.Count
    $files = @($files | Where-Object {
      if (-not $_.modified_time) { return $true }
      $t = [DateTimeOffset]::FromUnixTimeSeconds([int64]$_.modified_time).LocalDateTime
      return $t -ge $cutoff
    })
    if ($before -ne $files.Count) {
      Write-Ok "依「最近 $withinDays 天內修改」篩選後剩 $($files.Count) 個"
    }
  }

  if ($Test) {
    foreach ($f in $files) {
      $t = ''
      if ($f.modified_time) { $t = [DateTimeOffset]::FromUnixTimeSeconds([int64]$f.modified_time).LocalDateTime.ToString('yyyy-MM-dd HH:mm') }
      Write-Host ("    [{0,-7}] {1,-40} {2}" -f $f.type, $f.name, $t)
    }
    return [pscustomobject]@{ Label = $label; Ok = 0; Skipped = 0; Failed = 0; Listed = $files.Count }
  }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $ok = 0; $skipped = 0; $failed = 0
  foreach ($f in $files) {
    try {
      if ("$($f.type)" -eq 'file') {
        $p = Save-PlainFile $f $dir
        $ok++
        Write-Host "    ✓ $([IO.Path]::GetFileName($p))"
      } elseif ($doExport) {
        $p = Save-LarkDoc $f $dir
        if ($p) { $ok++; Write-Host "    ✓ $([IO.Path]::GetFileName($p))（由 Lark 雲文件匯出）" }
        else { $skipped++; Write-Warn2 "略過 $($f.name)（型別 $($f.type) 無法匯出）" }
      } else {
        $skipped++
        Write-Warn2 "略過 $($f.name)（雲文件，設定為不匯出）"
      }
    } catch {
      $failed++
      Write-Bad "$($f.name)：$(Get-DownloadError $_)"
    }
  }
  return [pscustomobject]@{ Label = $label; Ok = $ok; Skipped = $skipped; Failed = $failed; Listed = $files.Count }
}

$dateTag  = Get-Date -Format 'yyyy-MM-dd'
$dayDir   = Join-Path $outputRoot $dateTag
$orderDir = Join-Path $dayDir 'orders'
$shipDir  = Join-Path $dayDir 'ships'

Write-Host ''
$r1 = Sync-Side '訂單' $cfg.ordersFolderToken $orderDir
Write-Host ''
$r2 = Sync-Side '出貨' $cfg.shipsFolderToken  $shipDir

Write-Host ''
Write-Host '────────────────────────────────' -ForegroundColor DarkGray
if ($Test) {
  Write-Host "連線正常。訂單資料夾看到 $($r1.Listed) 個檔案，出貨資料夾看到 $($r2.Listed) 個。"
  Write-Host '確認清單沒問題後，把 -Test 拿掉重新執行就會實際下載。'
} else {
  foreach ($r in @($r1, $r2)) {
    $line = "$($r.Label)：下載 $($r.Ok) 個"
    if ($r.Skipped) { $line += "，略過 $($r.Skipped) 個" }
    if ($r.Failed)  { $line += "，失敗 $($r.Failed) 個" }
    Write-Host $line
  }
  Write-Host ''
  Write-Host "檔案位置：$dayDir"
  Write-Host '接著把 orders 與 ships 這兩個資料夾，分別拖進 order-check.html 的左右兩區。'
  if (Test-Path $dayDir) { try { Start-Process explorer.exe $dayDir } catch { } }
}
