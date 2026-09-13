<?php
/**
 * TSETMC relay for shared Iranian hosting (PHP + cURL) — no Node needed.
 *
 * Upload these two files to public_html/relay/ :
 *   relay/index.php   (this file)
 *   relay/.htaccess   (routes /relay/* to index.php)
 *
 * Test:  https://yourdomain.ir/relay/relay-health
 * Then set on your site:  TSETMC_RELAY=https://yourdomain.ir/relay
 *
 * Optional secret (recommended): set the same RELAY_SECRET value on the
 * site side; every call gets ?key=<secret> appended.
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit('{"error":"method not allowed"}'); }

// Local self-test (does not hit TSETMC)
if (isset($_GET['relay-health'])) {
  echo json_encode([
    'ok'       => true,
    'php'      => PHP_VERSION,
    'curl'     => extension_loaded('curl') ? 'yes' : 'no',
    'upstream' => 'https://cdn.tsetmc.com',
  ]);
  exit;
}

$SECRET  = getenv('RELAY_SECRET') ?: '';
$RELAY_KEY = $_GET['key'] ?? '';
unset($_GET['key']);
unset($_GET['relay-health']);

if ($SECRET !== '' && !hash_equals($SECRET, $RELAY_KEY)) {
  http_response_code(401);
  exit('{"error":"unauthorized"}');
}

// Rebuild query string after removing key/relay-health
$qs = http_build_query($_GET);

// Map: <relay-root>/<path...>  ->  https://cdn.tsetmc.com/<path...>
$uri  = $_SERVER['REQUEST_URI'];
$path = parse_url($uri, PHP_URL_PATH);
// Strip the directory this script lives in (e.g. /relay or /relay/)
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
if ($base !== '' && strpos($path, $base) === 0) {
  $path = substr($path, strlen($base));
}
$path = '/' . ltrim($path, '/');

$target = 'https://cdn.tsetmc.com' . $path . ($qs !== '' ? '?' . $qs : '');

$headers = [
  'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept: application/json, text/plain, */*',
  'Accept-Language: fa-IR,fa;q=0.9,en;q=0.8',
  'Referer: https://www.tsetmc.com/',
  'Origin: https://www.tsetmc.com',
  'Accept-Encoding: identity',
];

if (!function_exists('curl_init')) {
  http_response_code(500);
  exit('{"error":"php curl extension missing"}');
}

$ch = curl_init($target);
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT        => 12,
  CURLOPT_CONNECTTIMEOUT => 8,
  CURLOPT_HTTPHEADER     => $headers,
  CURLOPT_FOLLOWLOCATION => true,
  CURLOPT_MAXREDIRS      => 2,
  CURLOPT_ENCODING       => '', // transparent gzip
]);

$body     = curl_exec($ch);
$status   = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$ctype    = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/json; charset=utf-8';
$err      = curl_error($ch);
curl_close($ch);

if ($body === false || $status === 0) {
  http_response_code(502);
  exit(json_encode(['error' => 'relay error', 'detail' => $err ?: 'no response']));
}

// Sanity check: TSETMC returns JSON
$decoded = json_decode($body);
if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
  http_response_code(502);
  exit(json_encode(['error' => 'relay error', 'detail' => 'non-JSON from upstream']));
}

http_response_code($status);
header('Content-Type: ' . $ctype);
echo $body;
