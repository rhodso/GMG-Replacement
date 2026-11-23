<?php
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
	$new_list = array();
	foreach ($list as $sb) {
		$new_list[] = basename($sb);
	}
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