Write-Output ("EXPECTING_INPUT=" + $MyInvocation.ExpectingInput)
if ($MyInvocation.ExpectingInput) {
  $input | node C:/dev/claudsterfuck/.tmp/readstdin.js
} else {
  node C:/dev/claudsterfuck/.tmp/readstdin.js
}
