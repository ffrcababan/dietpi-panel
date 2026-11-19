<?php
declare(strict_types=1);

/**
 * Shared D1-style SQLite HTTP endpoint (/var/www/_shared/db.php).
 *
 * Reads per-vhost configuration from Apache SetEnv directives:
 *   APP_DB_PATH - absolute path to /srv/db/<app>/data.sqlite
 *   APP_API_KEY - bearer key validated against the x-api-key header
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function respond(int $status, array $payload): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function getEnvVar(string $key): string
{
    $val = $_SERVER[$key] ?? $_SERVER['REDIRECT_' . $key] ?? getenv($key);
    return is_string($val) ? trim($val) : '';
}

function getHeaderCaseInsensitive(string $name): string
{
    $serverKey = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (isset($_SERVER[$serverKey]) && is_string($_SERVER[$serverKey])) {
        return trim($_SERVER[$serverKey]);
    }
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        if (is_array($headers)) {
            $target = strtolower($name);
            foreach ($headers as $k => $v) {
                if (strtolower((string)$k) === $target && is_string($v)) {
                    return trim($v);
                }
            }
        }
    }
    return '';
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    respond(405, ['error' => 'Method not allowed; use POST']);
}

$dbPath = getEnvVar('APP_DB_PATH');
$expectedKey = getEnvVar('APP_API_KEY');

if ($dbPath === '' || $expectedKey === '') {
    respond(503, ['error' => 'Database is not configured for this virtual host']);
}

$providedKey = getHeaderCaseInsensitive('x-api-key');
if ($providedKey === '' || !hash_equals($expectedKey, $providedKey)) {
    respond(401, ['error' => 'Unauthorized']);
}

$rawBody = file_get_contents('php://input');
if ($rawBody === false || trim($rawBody) === '') {
    respond(400, ['error' => 'Empty request body']);
}

try {
    $body = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
} catch (\Throwable $e) {
    respond(400, ['error' => 'Invalid JSON body']);
}

if (!is_array($body) || !isset($body['sql']) || !is_string($body['sql'])) {
    respond(400, ['error' => 'Request JSON must contain a string "sql" field']);
}

$sql = trim($body['sql']);
if ($sql === '') {
    respond(400, ['error' => 'SQL query cannot be empty']);
}

$params = $body['params'] ?? [];
if (!is_array($params)) {
    respond(400, ['error' => 'Optional "params" field must be an array or object']);
}

if (!is_file($dbPath)) {
    respond(500, ['error' => 'Database file not found']);
}

try {
    $pdo = new PDO('sqlite:' . $dbPath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    $pdo->exec('PRAGMA busy_timeout = 5000;');
    $pdo->exec('PRAGMA journal_mode = WAL;');
    $pdo->exec('PRAGMA foreign_keys = ON;');

    $stmt = $pdo->prepare($sql);
    if ($stmt === false) {
        respond(400, ['error' => 'Failed to prepare SQL statement']);
    }

    $bindTyped = static function (PDOStatement $s, int|string $paramKey, mixed $value): void {
        if ($value === null) {
            $s->bindValue($paramKey, null, PDO::PARAM_NULL);
        } elseif (is_bool($value)) {
            $s->bindValue($paramKey, $value ? 1 : 0, PDO::PARAM_INT);
        } elseif (is_int($value)) {
            $s->bindValue($paramKey, $value, PDO::PARAM_INT);
        } elseif (is_float($value)) {
            $s->bindValue($paramKey, (string)$value, PDO::PARAM_STR);
        } elseif (is_string($value)) {
            $s->bindValue($paramKey, $value, PDO::PARAM_STR);
        } else {
            throw new InvalidArgumentException('Unsupported parameter value type');
        }
    };

    if ($params !== []) {
        if (array_is_list($params)) {
            foreach ($params as $index => $value) {
                $bindTyped($stmt, $index + 1, $value);
            }
        } else {
            foreach ($params as $key => $value) {
                $name = str_starts_with((string)$key, ':') ? (string)$key : ':' . (string)$key;
                $bindTyped($stmt, $name, $value);
            }
        }
    }

    $stmt->execute();

    if ($stmt->columnCount() > 0) {
        $rows = $stmt->fetchAll();
        respond(200, ['results' => $rows]);
    }

    respond(200, ['changes' => $stmt->rowCount()]);
} catch (InvalidArgumentException $e) {
    respond(400, ['error' => $e->getMessage()]);
} catch (PDOException $e) {
    respond(400, ['error' => $e->getMessage()]);
} catch (\Throwable $e) {
    respond(500, ['error' => 'Internal database error']);
}
