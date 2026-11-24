<?php
function removeTagsAndStuff($string)
{
	// Remove tags
	$string = strip_tags($string);
	// Remove whitespace
	$string = trim($string);
	$string = stripslashes($string);
	$string = htmlspecialchars($string);
	// Remove single and double quotes
	$string = str_replace("'", "", $string);
	$string = str_replace('"', "", $string);

	return $string;
}

function ensureNoFunnyBusiness($string)
{
	$string = trim($string);
	$string = stripslashes($string);
	$string = htmlspecialchars($string);
	return $string;
}

function detectFunnyBusiness($string, $expected_type)
{
	switch ($expected_type) {
		case "string":
			// Check that the string is a string
			if (!is_string($string)) {
				return true;
			}
			break;
		case "integer":
			// Check that the string is an integer
			if (!is_int($string)) {
				return true;
			}
			break;
		case "number":
			// Check that the string is a number
			if (!is_numeric($string)) {
				return true;
			}
			break;
	}

	// Type is ok, trim
	$string = trim($string);

	$testString = ensureNoFunnyBusiness($string);
	return $testString != $string;
}

?>