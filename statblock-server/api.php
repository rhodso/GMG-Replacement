<?php
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';

// Will be uncommented in prod
// $allowedOrigins = [
// 	'https://www.owlbear.rodeo',
// 	'http://localhost:5173',
// 	'https://YOUR-TURNKEEPER-HOST'
// ];

// if (in_array($origin, $allowedOrigins, true)) {
// 	header("Access-Control-Allow-Origin: $origin");
// 	header('Vary: Origin');
// }

header('Access-Control-Allow-Origin: *'); // tmp, removed in prod
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Handle browser preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
	http_response_code(204);
	exit;
}

require_once 'check.php';
// phpinfo();

ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

// Start session
session_start();

// Show errors
function showError($m)
{
	echo '<p class="error">' . $m . '</p>';
}

// Get request and check
$request = $_GET['request'];

if (!isset($request)) {
	showError('Request not set');
	exit;
}

if (detectFunnyBusiness($request, "string")) {
	showError('No');
}

// Get statblocks
function get_sb()
{
	// $list = scandir('statblocks');
	$list = glob("./statblocks/*.json");
	$new_list = array_map(function ($x) {
		return basename($x);
	}, $list);
	return $new_list;
}

// Test requests
if ($request == -1) {
	echo 'OK';
}

// Get a list of statblocks
if ($request == 0) {
	$json = json_encode(get_sb(), JSON_THROW_ON_ERROR);
	echo $json;
}

// Get a specific statblock
if ($request == 1) {

	// Ensure sb name is set
	$sb_name = $_GET['sb'];
	if (!isset($sb_name)) {
		showError('sb_name not set');
		exit;
	}

	// check for the big funny
	if (detectFunnyBusiness($sb_name, "string")) {
		showError('No');
	}

	// validate sb
	$list = get_sb();
	$sb_name = $sb_name . '.json';

	if (!in_array($sb_name, $list)) {
		showError('sb_name not in list');
		exit;
	}

	// sb valid, return
	$sb = file_get_contents('./statblocks/' . $sb_name);
	echo $sb;
}
?>