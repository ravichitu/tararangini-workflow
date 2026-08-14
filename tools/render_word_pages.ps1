param(
  [Parameter(Mandatory = $true)][string]$DocumentPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$word = New-Object -ComObject Word.Application
$powerPoint = New-Object -ComObject PowerPoint.Application
$word.Visible = $false

try {
  $document = $word.Documents.Open($DocumentPath, $false, $true)
  $pageCount = $document.ComputeStatistics(2)
  $presentation = $powerPoint.Presentations.Add()
  $presentation.PageSetup.SlideWidth = 612
  $presentation.PageSetup.SlideHeight = 792

  for ($pageNumber = 1; $pageNumber -le $pageCount; $pageNumber++) {
    $selection = $word.Selection
    $selection.GoTo(1, 1, $pageNumber) | Out-Null
    $pageRange = $selection.Bookmarks.Item('\Page').Range
    $pageRange.CopyAsPicture()
    Start-Sleep -Milliseconds 250

    $slide = $presentation.Slides.Add($presentation.Slides.Count + 1, 12)
    $slide.FollowMasterBackground = $false
    $slide.Background.Fill.ForeColor.RGB = 16777215
    $shape = $slide.Shapes.Paste()[1]
    $shape.Left = 0
    $shape.Top = 0
    $shape.Width = 612
    $shape.Height = 792
    $slide.Export(
      (Join-Path $OutputDirectory ('page-{0:D2}.png' -f $pageNumber)),
      'PNG',
      1275,
      1650
    )
    $slide.Delete()
  }

  $presentation.Close()
  $document.Close($false)
  Write-Output $pageCount
}
finally {
  $word.Quit()
  $powerPoint.Quit()
}
