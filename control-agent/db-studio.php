<?php
declare(strict_types=1);

/**
 * DietPi Panel Built-in SQLite Studio Worker (executed as www-data via control-agent).
 * Reads a single JSON request file path from argv[1] and emits a single JSON line.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

function respond(array $payload, int $exitCode = 0): never
{
    echo json_encode(
        $payload,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    ) . "\n";
    exit($exitCode);
}

function quoteIdent(string $ident): string
{
    return '"' . str_replace('"', '""', $ident) . '"';
}

function validateIdentifier(mixed $raw, string $label = 'identifier', bool $allowSqlitePrefix = false): string
{
    if (!is_string($raw)) {
        throw new InvalidArgumentException("Invalid {$label}: must be a string");
    }
    $val = trim($raw);
    if ($val === '' || strlen($val) > 64) {
        throw new InvalidArgumentException("Invalid {$label}: must be 1-64 characters");
    }
    if (str_contains($val, "\0") || preg_match('/[\r\n\t]/', $val)) {
        throw new InvalidArgumentException("Invalid {$label}: control characters not allowed");
    }
    if (!$allowSqlitePrefix && str_starts_with(strtolower($val), 'sqlite_')) {
        throw new InvalidArgumentException("Invalid {$label}: names starting with sqlite_ are reserved");
    }
    if (!preg_match('/^[A-Za-z_][A-Za-z0-9_ -]{0,63}$/', $val)) {
        throw new InvalidArgumentException(
            "Invalid {$label}: start with a letter or underscore and use letters, digits, spaces, underscores, or hyphens"
        );
    }
    return $val;
}

function validateColumnType(mixed $raw): string
{
    if ($raw === null || $raw === '') {
        return 'TEXT';
    }
    if (!is_string($raw)) {
        throw new InvalidArgumentException('Column type must be a string');
    }
    $val = strtoupper(trim(preg_replace('/\s+/', ' ', $raw)));
    if (!preg_match('/^[A-Z][A-Z0-9_ ]{0,32}(\(\s*\d+(\s*,\s*\d+)?\s*\))?$/', $val)) {
        throw new InvalidArgumentException('Invalid SQLite column type syntax');
    }
    return $val;
}

function formatDefaultSql(PDO $pdo, mixed $defaultMode, mixed $defaultValue): ?string
{
    $mode = is_string($defaultMode) ? $defaultMode : 'none';
    return match ($mode) {
        'none' => null,
        'null' => 'NULL',
        'current_timestamp' => 'CURRENT_TIMESTAMP',
        'current_date' => 'CURRENT_DATE',
        'current_time' => 'CURRENT_TIME',
        'empty_string' => "''",
        'number' => (function () use ($defaultValue): string {
            if (!is_string($defaultValue) && !is_int($defaultValue) && !is_float($defaultValue)) {
                throw new InvalidArgumentException('Numeric default value is required');
            }
            $str = trim((string)$defaultValue);
            if (!preg_match('/^-?\d+(?:\.\d+)?$/', $str)) {
                throw new InvalidArgumentException('Default value must be a valid integer or decimal number');
            }
            return $str;
        })(),
        'string' => $pdo->quote(is_string($defaultValue) ? $defaultValue : (string)($defaultValue ?? '')),
        default => throw new InvalidArgumentException("Unsupported defaultMode: {$mode}"),
    };
}

function encodeCellValue(mixed $val): mixed
{
    if ($val === null || is_int($val) || is_float($val) || is_bool($val)) {
        return $val;
    }
    $str = (string)$val;
    if (str_contains($str, "\0") || !mb_check_encoding($str, 'UTF-8')) {
        return [
            '__blob' => true,
            'bytes' => strlen($str),
            'base64' => base64_encode($str),
        ];
    }
    return $str;
}

function bindTypedParam(PDOStatement $stmt, int|string $key, mixed $spec): void
{
    if (is_array($spec) && array_key_exists('isNull', $spec)) {
        if (!empty($spec['isNull'])) {
            $stmt->bindValue($key, null, PDO::PARAM_NULL);
            return;
        }
        $typeHint = $spec['valueType'] ?? 'auto';
        $val = $spec['value'] ?? '';
        if ($typeHint === 'blob' && is_string($val)) {
            $decoded = base64_decode($val, true);
            if ($decoded === false) {
                throw new InvalidArgumentException('Invalid base64 value for BLOB field');
            }
            $stmt->bindValue($key, $decoded, PDO::PARAM_LOB);
            return;
        }
        if ($typeHint === 'integer') {
            $str = trim((string)$val);
            if (!preg_match('/^-?\d+$/', $str)) {
                throw new InvalidArgumentException("Expected integer value, got '{$str}'");
            }
            $stmt->bindValue($key, (int)$str, PDO::PARAM_INT);
            return;
        }
        if ($typeHint === 'number') {
            $str = trim((string)$val);
            if (!is_numeric($str)) {
                throw new InvalidArgumentException("Expected numeric value, got '{$str}'");
            }
            $stmt->bindValue($key, str_contains($str, '.') ? $str : (int)$str, str_contains($str, '.') ? PDO::PARAM_STR : PDO::PARAM_INT);
            return;
        }
        $stmt->bindValue($key, (string)$val, PDO::PARAM_STR);
        return;
    }

    if (is_array($spec) && !empty($spec['__blob']) && is_string($spec['base64'] ?? null)) {
        $decoded = base64_decode($spec['base64'], true);
        if ($decoded === false) {
            throw new InvalidArgumentException('Invalid base64 BLOB payload');
        }
        $stmt->bindValue($key, $decoded, PDO::PARAM_LOB);
        return;
    }

    if ($spec === null) {
        $stmt->bindValue($key, null, PDO::PARAM_NULL);
    } elseif (is_bool($spec)) {
        $stmt->bindValue($key, $spec ? 1 : 0, PDO::PARAM_INT);
    } elseif (is_int($spec)) {
        $stmt->bindValue($key, $spec, PDO::PARAM_INT);
    } elseif (is_float($spec)) {
        $stmt->bindValue($key, (string)$spec, PDO::PARAM_STR);
    } else {
        $stmt->bindValue($key, (string)$spec, PDO::PARAM_STR);
    }
}

function getObjectRecord(PDO $pdo, string $name): array
{
    $stmt = $pdo->prepare(
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? AND name NOT LIKE 'sqlite_%' LIMIT 1"
    );
    $stmt->execute([$name]);
    $row = $stmt->fetch();
    if (!$row) {
        throw new InvalidArgumentException("Table or view \"{$name}\" does not exist");
    }
    return $row;
}

function getTableColumns(PDO $pdo, string $tableName): array
{
    $stmt = $pdo->query('PRAGMA table_info(' . quoteIdent($tableName) . ')');
    $cols = [];
    foreach ($stmt->fetchAll() as $r) {
        $cols[] = [
            'cid' => (int)$r['cid'],
            'name' => (string)$r['name'],
            'type' => (string)($r['type'] ?? ''),
            'notnull' => ((int)$r['notnull']) === 1,
            'defaultValue' => $r['dflt_value'],
            'pk' => (int)$r['pk'],
        ];
    }
    return $cols;
}

function getRowIdAlias(PDO $pdo, string $tableName, array $columns, ?string $tableSql): ?string
{
    if ($tableSql !== null && preg_match('/\bWITHOUT\s+ROWID\b/i', $tableSql)) {
        return null;
    }
    $colNamesLower = array_map(static fn(array $c): string => strtolower($c['name']), $columns);
    foreach (['_rowid_', 'rowid', 'oid'] as $candidate) {
        if (!in_array($candidate, $colNamesLower, true)) {
            try {
                $pdo->query('SELECT ' . $candidate . ' FROM ' . quoteIdent($tableName) . ' LIMIT 0');
                return $candidate;
            } catch (Throwable) {
                return null;
            }
        }
    }
    return null;
}

function handleSchema(PDO $pdo, array $req): array
{
    $version = (string)$pdo->query('SELECT sqlite_version()')->fetchColumn();
    $objs = $pdo->query(
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY CASE WHEN type = 'table' THEN 0 ELSE 1 END, name ASC"
    )->fetchAll();

    $tables = [];
    foreach ($objs as $obj) {
        $tName = (string)$obj['name'];
        $tType = (string)$obj['type'];
        $tSql = isset($obj['sql']) ? (string)$obj['sql'] : null;
        $cols = getTableColumns($pdo, $tName);
        $rowCount = 0;
        if ($tType === 'table') {
            $rowCount = (int)$pdo->query('SELECT COUNT(*) FROM ' . quoteIdent($tName))->fetchColumn();
        } else {
            try {
                $rowCount = (int)$pdo->query('SELECT COUNT(*) FROM ' . quoteIdent($tName))->fetchColumn();
            } catch (Throwable) {
                $rowCount = 0;
            }
        }

        $rowIdAlias = $tType === 'table' ? getRowIdAlias($pdo, $tName, $cols, $tSql) : null;
        $pkCols = array_values(array_filter($cols, static fn(array $c): bool => $c['pk'] > 0));
        usort($pkCols, static fn(array $a, array $b): int => $a['pk'] <=> $b['pk']);

        $indexes = [];
        if ($tType === 'table') {
            $idxRows = $pdo->query('PRAGMA index_list(' . quoteIdent($tName) . ')')->fetchAll();
            foreach ($idxRows as $idx) {
                $idxName = (string)$idx['name'];
                $idxInfo = $pdo->query('PRAGMA index_info(' . quoteIdent($idxName) . ')')->fetchAll();
                $idxCols = array_map(static fn(array $ic): string => (string)$ic['name'], $idxInfo);
                $indexes[] = [
                    'name' => $idxName,
                    'unique' => ((int)$idx['unique']) === 1,
                    'origin' => (string)($idx['origin'] ?? ''),
                    'columns' => $idxCols,
                ];
            }
        }

        $fks = [];
        if ($tType === 'table') {
            $fkRows = $pdo->query('PRAGMA foreign_key_list(' . quoteIdent($tName) . ')')->fetchAll();
            foreach ($fkRows as $fk) {
                $fks[] = [
                    'id' => (int)$fk['id'],
                    'table' => (string)$fk['table'],
                    'from' => (string)$fk['from'],
                    'to' => (string)$fk['to'],
                    'onUpdate' => (string)$fk['on_update'],
                    'onDelete' => (string)$fk['on_delete'],
                ];
            }
        }

        $tables[] = [
            'name' => $tName,
            'type' => $tType,
            'sql' => $tSql,
            'rowCount' => $rowCount,
            'withoutRowId' => $tType === 'table' && $rowIdAlias === null,
            'hasEditableKey' => $tType === 'table' && ($rowIdAlias !== null || count($pkCols) > 0),
            'primaryKey' => array_map(static fn(array $c): string => $c['name'], $pkCols),
            'columns' => $cols,
            'indexes' => $indexes,
            'foreignKeys' => $fks,
        ];
    }

    return [
        'ok' => true,
        'sqliteVersion' => $version,
        'tables' => $tables,
    ];
}

function handleRowsList(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['table'] ?? '', 'table name', true);
    $obj = getObjectRecord($pdo, $tableName);
    $cols = getTableColumns($pdo, $tableName);
    $colNames = array_map(static fn(array $c): string => $c['name'], $cols);

    $page = max(1, (int)($req['page'] ?? 1));
    $pageSize = min(200, max(1, (int)($req['pageSize'] ?? 50)));
    $offset = ($page - 1) * $pageSize;
    $search = is_string($req['search'] ?? null) ? trim($req['search']) : '';

    $rowIdAlias = $obj['type'] === 'table'
        ? getRowIdAlias($pdo, $tableName, $cols, isset($obj['sql']) ? (string)$obj['sql'] : null)
        : null;
    $pkCols = array_values(array_filter($cols, static fn(array $c): bool => $c['pk'] > 0));
    usort($pkCols, static fn(array $a, array $b): int => $a['pk'] <=> $b['pk']);

    $whereSql = '';
    $bindParams = [];
    if ($search !== '' && count($cols) > 0) {
        $likes = [];
        foreach ($cols as $idx => $c) {
            $param = ":q{$idx}";
            $likes[] = 'CAST(' . quoteIdent($c['name']) . " AS TEXT) LIKE {$param} ESCAPE '\\'";
            $escapedSearch = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search);
            $bindParams[$param] = "%{$escapedSearch}%";
        }
        $whereSql = ' WHERE (' . implode(' OR ', $likes) . ')';
    }

    $sortBy = is_string($req['sortBy'] ?? null) ? trim($req['sortBy']) : '';
    $sortDir = strtoupper(is_string($req['sortDir'] ?? null) ? $req['sortDir'] : 'ASC') === 'DESC' ? 'DESC' : 'ASC';

    $orderSql = '';
    if ($sortBy !== '' && in_array($sortBy, $colNames, true)) {
        $orderSql = ' ORDER BY ' . quoteIdent($sortBy) . ' ' . $sortDir;
    } elseif ($rowIdAlias !== null) {
        $orderSql = " ORDER BY {$rowIdAlias} {$sortDir}";
    } elseif (count($pkCols) > 0) {
        $orderSql = ' ORDER BY ' . implode(', ', array_map(
            static fn(array $c): string => quoteIdent($c['name']) . ' ' . $sortDir,
            $pkCols
        ));
    }

    $qTable = quoteIdent($tableName);
    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM {$qTable}{$whereSql}");
    foreach ($bindParams as $k => $v) {
        $countStmt->bindValue($k, $v, PDO::PARAM_STR);
    }
    $countStmt->execute();
    $totalRows = (int)$countStmt->fetchColumn();

    $selectParts = [];
    if ($rowIdAlias !== null) {
        $selectParts[] = "{$rowIdAlias} AS \"__dp_rowid__\"";
    }
    foreach ($colNames as $cn) {
        $selectParts[] = quoteIdent($cn);
    }
    $selectList = count($selectParts) > 0 ? implode(', ', $selectParts) : '*';

    $dataStmt = $pdo->prepare(
        "SELECT {$selectList} FROM {$qTable}{$whereSql}{$orderSql} LIMIT :limit OFFSET :offset"
    );
    foreach ($bindParams as $k => $v) {
        $dataStmt->bindValue($k, $v, PDO::PARAM_STR);
    }
    $dataStmt->bindValue(':limit', $pageSize, PDO::PARAM_INT);
    $dataStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $dataStmt->execute();

    $rawRows = $dataStmt->fetchAll(PDO::FETCH_NUM);
    $rows = [];
    $offsetIdx = $rowIdAlias !== null ? 1 : 0;
    foreach ($rawRows as $r) {
        $rowKey = null;
        if ($rowIdAlias !== null) {
            $rowKey = ['rowid' => (string)$r[0]];
        } elseif (count($pkCols) > 0) {
            $pkMap = [];
            foreach ($pkCols as $pkCol) {
                $colPos = array_search($pkCol['name'], $colNames, true);
                if ($colPos !== false) {
                    $pkMap[$pkCol['name']] = encodeCellValue($r[$offsetIdx + $colPos] ?? null);
                }
            }
            $rowKey = ['pk' => $pkMap];
        }

        $cells = [];
        foreach ($colNames as $cIdx => $cn) {
            $cells[$cn] = encodeCellValue($r[$offsetIdx + $cIdx] ?? null);
        }
        $rows[] = [
            'rowKey' => $rowKey,
            'cells' => $cells,
        ];
    }

    return [
        'ok' => true,
        'table' => $tableName,
        'type' => $obj['type'],
        'columns' => $cols,
        'hasEditableKey' => $obj['type'] === 'table' && ($rowIdAlias !== null || count($pkCols) > 0),
        'page' => $page,
        'pageSize' => $pageSize,
        'totalRows' => $totalRows,
        'rows' => $rows,
    ];
}

function buildRowWhereClause(PDO $pdo, string $tableName, array $cols, ?string $tableSql, mixed $rowKey): array
{
    if (!is_array($rowKey)) {
        throw new InvalidArgumentException('Row key is required');
    }
    $rowIdAlias = getRowIdAlias($pdo, $tableName, $cols, $tableSql);
    if ($rowIdAlias !== null && isset($rowKey['rowid'])) {
        $rawId = (string)$rowKey['rowid'];
        if (!preg_match('/^-?\d+$/', $rawId)) {
            throw new InvalidArgumentException('Invalid numeric rowid');
        }
        return [
            'sql' => "{$rowIdAlias} = ?",
            'binds' => [(int)$rawId],
        ];
    }

    $pkCols = array_values(array_filter($cols, static fn(array $c): bool => $c['pk'] > 0));
    if (count($pkCols) > 0 && isset($rowKey['pk']) && is_array($rowKey['pk'])) {
        $conds = [];
        $binds = [];
        foreach ($pkCols as $pkCol) {
            $pkName = $pkCol['name'];
            if (!array_key_exists($pkName, $rowKey['pk'])) {
                throw new InvalidArgumentException("Missing primary key field '{$pkName}'");
            }
            $val = $rowKey['pk'][$pkName];
            if ($val === null) {
                $conds[] = quoteIdent($pkName) . ' IS NULL';
            } else {
                $conds[] = quoteIdent($pkName) . ' = ?';
                $binds[] = $val;
            }
        }
        return [
            'sql' => implode(' AND ', $conds),
            'binds' => $binds,
        ];
    }

    throw new InvalidArgumentException('Table lacks a rowid or primary key for single-row mutation');
}

function handleInsertRow(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['table'] ?? '', 'table name');
    $obj = getObjectRecord($pdo, $tableName);
    if ($obj['type'] !== 'table') {
        throw new InvalidArgumentException('Cannot insert rows into a view');
    }
    $cols = getTableColumns($pdo, $tableName);
    $validCols = array_map(static fn(array $c): string => $c['name'], $cols);

    $values = $req['values'] ?? [];
    if (!is_array($values)) {
        throw new InvalidArgumentException('values must be an object');
    }

    $qTable = quoteIdent($tableName);
    if (count($values) === 0) {
        $pdo->exec("INSERT INTO {$qTable} DEFAULT VALUES");
        return ['ok' => true, 'insertedId' => $pdo->lastInsertId(), 'changes' => 1];
    }

    $insertCols = [];
    $binds = [];
    foreach ($values as $colName => $spec) {
        if (!in_array($colName, $validCols, true)) {
            throw new InvalidArgumentException("Unknown column: {$colName}");
        }
        $insertCols[] = quoteIdent((string)$colName);
        $binds[] = $spec;
    }

    $placeholders = implode(', ', array_fill(0, count($insertCols), '?'));
    $stmt = $pdo->prepare(
        "INSERT INTO {$qTable} (" . implode(', ', $insertCols) . ") VALUES ({$placeholders})"
    );
    foreach ($binds as $idx => $spec) {
        bindTypedParam($stmt, $idx + 1, $spec);
    }
    $stmt->execute();

    return [
        'ok' => true,
        'insertedId' => $pdo->lastInsertId(),
        'changes' => $stmt->rowCount(),
    ];
}

function handleUpdateRow(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['table'] ?? '', 'table name');
    $obj = getObjectRecord($pdo, $tableName);
    if ($obj['type'] !== 'table') {
        throw new InvalidArgumentException('Cannot update rows in a view');
    }
    $cols = getTableColumns($pdo, $tableName);
    $validCols = array_map(static fn(array $c): string => $c['name'], $cols);

    $values = $req['values'] ?? [];
    if (!is_array($values) || count($values) === 0) {
        throw new InvalidArgumentException('At least one column update is required');
    }

    $where = buildRowWhereClause(
        $pdo,
        $tableName,
        $cols,
        isset($obj['sql']) ? (string)$obj['sql'] : null,
        $req['rowKey'] ?? null
    );

    $setClauses = [];
    $binds = [];
    foreach ($values as $colName => $spec) {
        if (!in_array($colName, $validCols, true)) {
            throw new InvalidArgumentException("Unknown column: {$colName}");
        }
        $setClauses[] = quoteIdent((string)$colName) . ' = ?';
        $binds[] = $spec;
    }

    $qTable = quoteIdent($tableName);
    $stmt = $pdo->prepare(
        "UPDATE {$qTable} SET " . implode(', ', $setClauses) . " WHERE {$where['sql']}"
    );
    $pos = 1;
    foreach ($binds as $spec) {
        bindTypedParam($stmt, $pos++, $spec);
    }
    foreach ($where['binds'] as $wVal) {
        bindTypedParam($stmt, $pos++, $wVal);
    }
    $stmt->execute();
    if ($stmt->rowCount() === 0) {
        $chk = $pdo->prepare("SELECT 1 FROM {$qTable} WHERE {$where['sql']} LIMIT 1");
        foreach ($where['binds'] as $idx => $wVal) {
            bindTypedParam($chk, $idx + 1, $wVal);
        }
        $chk->execute();
        if ($chk->fetchColumn() === false) {
            throw new RuntimeException('Target row no longer exists');
        }
    }

    return ['ok' => true, 'changes' => $stmt->rowCount()];
}

function handleDeleteRows(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['table'] ?? '', 'table name');
    $obj = getObjectRecord($pdo, $tableName);
    if ($obj['type'] !== 'table') {
        throw new InvalidArgumentException('Cannot delete rows from a view');
    }
    $cols = getTableColumns($pdo, $tableName);
    $rowKeys = $req['rowKeys'] ?? null;
    if (!is_array($rowKeys) || count($rowKeys) === 0 || count($rowKeys) > 100) {
        throw new InvalidArgumentException('rowKeys must contain 1 to 100 row keys');
    }

    $qTable = quoteIdent($tableName);
    $tableSql = isset($obj['sql']) ? (string)$obj['sql'] : null;
    $deleted = 0;

    $pdo->beginTransaction();
    try {
        foreach ($rowKeys as $rk) {
            $where = buildRowWhereClause($pdo, $tableName, $cols, $tableSql, $rk);
            $stmt = $pdo->prepare("DELETE FROM {$qTable} WHERE {$where['sql']}");
            foreach ($where['binds'] as $idx => $wVal) {
                bindTypedParam($stmt, $idx + 1, $wVal);
            }
            $stmt->execute();
            $deleted += $stmt->rowCount();
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['ok' => true, 'deleted' => $deleted];
}

function handleCreateTable(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['tableName'] ?? '', 'table name');
    $colsInput = $req['columns'] ?? null;
    if (!is_array($colsInput) || count($colsInput) === 0 || count($colsInput) > 64) {
        throw new InvalidArgumentException('Provide 1 to 64 columns');
    }

    $seen = [];
    $pkCols = [];
    $aiCount = 0;
    foreach ($colsInput as $c) {
        if (!is_array($c)) {
            throw new InvalidArgumentException('Invalid column definition');
        }
        $cName = validateIdentifier($c['name'] ?? '', 'column name');
        $lower = strtolower($cName);
        if (isset($seen[$lower])) {
            throw new InvalidArgumentException("Duplicate column name: {$cName}");
        }
        $seen[$lower] = true;
        if (!empty($c['primaryKey'])) {
            $pkCols[] = $cName;
        }
        if (!empty($c['autoIncrement'])) {
            $aiCount += 1;
        }
    }

    if ($aiCount > 1 || ($aiCount === 1 && count($pkCols) !== 1)) {
        throw new InvalidArgumentException('AUTOINCREMENT requires a single INTEGER PRIMARY KEY column');
    }

    $defs = [];
    $singlePk = count($pkCols) === 1;
    foreach ($colsInput as $c) {
        $cName = validateIdentifier($c['name'] ?? '', 'column name');
        $isPk = !empty($c['primaryKey']);
        $isAi = !empty($c['autoIncrement']);
        $cType = $isAi ? 'INTEGER' : validateColumnType($c['type'] ?? 'TEXT');
        if ($isAi && !str_contains($cType, 'INT')) {
            throw new InvalidArgumentException('AUTOINCREMENT column must have INTEGER type');
        }

        $parts = [quoteIdent($cName), $cType];
        if ($singlePk && $isPk) {
            $parts[] = 'PRIMARY KEY';
            if ($isAi) {
                $parts[] = 'AUTOINCREMENT';
            }
        }
        if (!empty($c['notNull']) && !($singlePk && $isPk)) {
            $parts[] = 'NOT NULL';
        }
        $dflt = formatDefaultSql($pdo, $c['defaultMode'] ?? 'none', $c['defaultValue'] ?? null);
        if ($dflt !== null) {
            $parts[] = "DEFAULT {$dflt}";
        }
        $defs[] = implode(' ', $parts);
    }

    if (count($pkCols) > 1) {
        $defs[] = 'PRIMARY KEY (' . implode(', ', array_map('quoteIdent', $pkCols)) . ')';
    }

    $qTable = quoteIdent($tableName);
    $pdo->exec("CREATE TABLE {$qTable} (\n  " . implode(",\n  ", $defs) . "\n)");
    return ['ok' => true, 'table' => $tableName];
}

function handleDropTable(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['tableName'] ?? '', 'table name');
    $obj = getObjectRecord($pdo, $tableName);
    $qName = quoteIdent($tableName);
    $kw = $obj['type'] === 'view' ? 'VIEW' : 'TABLE';
    $pdo->exec("DROP {$kw} {$qName}");
    return ['ok' => true, 'dropped' => $tableName, 'type' => $obj['type']];
}

function handleAddColumn(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['table'] ?? '', 'table name');
    $obj = getObjectRecord($pdo, $tableName);
    if ($obj['type'] !== 'table') {
        throw new InvalidArgumentException('Cannot alter columns of a view');
    }
    $colSpec = $req['column'] ?? null;
    if (!is_array($colSpec)) {
        throw new InvalidArgumentException('column definition is required');
    }

    $cName = validateIdentifier($colSpec['name'] ?? '', 'column name');
    $existing = getTableColumns($pdo, $tableName);
    foreach ($existing as $ec) {
        if (strtolower($ec['name']) === strtolower($cName)) {
            throw new InvalidArgumentException("Column \"{$cName}\" already exists");
        }
    }

    $cType = validateColumnType($colSpec['type'] ?? 'TEXT');
    $notNull = !empty($colSpec['notNull']);
    $dflt = formatDefaultSql($pdo, $colSpec['defaultMode'] ?? 'none', $colSpec['defaultValue'] ?? null);

    if ($notNull && ($dflt === null || strtoupper($dflt) === 'NULL')) {
        $cnt = (int)$pdo->query('SELECT COUNT(*) FROM ' . quoteIdent($tableName))->fetchColumn();
        if ($cnt > 0) {
            throw new InvalidArgumentException(
                'Adding a NOT NULL column to a non-empty table requires a non-NULL DEFAULT value'
            );
        }
    }

    $parts = ['ALTER TABLE ' . quoteIdent($tableName) . ' ADD COLUMN', quoteIdent($cName), $cType];
    if ($notNull) {
        $parts[] = 'NOT NULL';
    }
    if ($dflt !== null) {
        $parts[] = "DEFAULT {$dflt}";
    }
    $pdo->exec(implode(' ', $parts));

    return ['ok' => true, 'table' => $tableName, 'column' => $cName];
}

function rebuildTableForColumnUpdate(
    PDO $pdo,
    string $tableName,
    string $targetColName,
    string $newType,
    bool $newNotNull,
    ?string $newDefaultSql,
    ?string $nullBackfillExpr
): void {
    $obj = getObjectRecord($pdo, $tableName);
    $tableSql = (string)($obj['sql'] ?? '');
    $cols = getTableColumns($pdo, $tableName);
    $qTable = quoteIdent($tableName);

    $fkRows = $pdo->query("PRAGMA foreign_key_list({$qTable})")->fetchAll();
    $idxStmt = $pdo->prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
    );
    $idxStmt->execute([$tableName]);
    $indexes = $idxStmt->fetchAll();

    // Capture inline/table UNIQUE constraints (origin = 'u', whose sqlite_master.sql is NULL)
    $uniqueConstraints = [];
    foreach ($pdo->query("PRAGMA index_list({$qTable})")->fetchAll() as $idxRow) {
        if (($idxRow['origin'] ?? '') !== 'u') {
            continue;
        }
        $idxName = (string)($idxRow['name'] ?? '');
        if ($idxName === '') {
            continue;
        }
        $uInfo = $pdo->query('PRAGMA index_info(' . quoteIdent($idxName) . ')')->fetchAll();
        usort($uInfo, static fn(array $a, array $b): int => ((int)$a['seqno']) <=> ((int)$b['seqno']));
        $uCols = [];
        foreach ($uInfo as $ui) {
            $uColName = $ui['name'] ?? null;
            if (is_string($uColName) && $uColName !== '') {
                $uCols[] = $uColName;
            }
        }
        if (count($uCols) > 0) {
            $uniqueConstraints[] = $uCols;
        }
    }

    // Capture triggers attached to the table before DROP TABLE deletes them
    $trgStmt = $pdo->prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL"
    );
    $trgStmt->execute([$tableName]);
    $triggers = $trgStmt->fetchAll();

    $hasAutoIncrement = preg_match('/\bAUTOINCREMENT\b/i', $tableSql) === 1;
    $withoutRowId = preg_match('/\bWITHOUT\s+ROWID\b/i', $tableSql) === 1;

    $pkCols = array_values(array_filter($cols, static fn(array $c): bool => $c['pk'] > 0));
    usort($pkCols, static fn(array $a, array $b): int => $a['pk'] <=> $b['pk']);
    $singlePk = count($pkCols) === 1;

    $colDefs = [];
    $colNames = [];
    $selectExprs = [];
    foreach ($cols as $c) {
        $colName = $c['name'];
        $colNames[] = quoteIdent($colName);
        $isTarget = $colName === $targetColName;
        $type = $isTarget ? $newType : ($c['type'] !== '' ? $c['type'] : 'TEXT');
        $notNull = $isTarget ? $newNotNull : $c['notnull'];
        $dflt = $isTarget ? $newDefaultSql : $c['defaultValue'];
        $isPk = $c['pk'] > 0;

        $parts = [quoteIdent($colName), $type];
        if ($singlePk && $isPk) {
            $parts[] = 'PRIMARY KEY';
            if ($hasAutoIncrement && str_contains(strtoupper($type), 'INT')) {
                $parts[] = 'AUTOINCREMENT';
            }
        }
        if ($notNull && !($singlePk && $isPk && strtoupper($type) === 'INTEGER')) {
            $parts[] = 'NOT NULL';
        }
        if ($dflt !== null && $dflt !== '') {
            $parts[] = "DEFAULT {$dflt}";
        }
        $colDefs[] = implode(' ', $parts);

        if ($isTarget && $nullBackfillExpr !== null) {
            $selectExprs[] = 'COALESCE(' . quoteIdent($colName) . ", {$nullBackfillExpr})";
        } else {
            $selectExprs[] = quoteIdent($colName);
        }
    }

    if (count($pkCols) > 1) {
        $colDefs[] = 'PRIMARY KEY (' . implode(', ', array_map(static fn(array $c): string => quoteIdent($c['name']), $pkCols)) . ')';
    }

    foreach ($uniqueConstraints as $uCols) {
        $colDefs[] = 'UNIQUE (' . implode(', ', array_map('quoteIdent', $uCols)) . ')';
    }

    // Group composite foreign keys by fk id
    $fkGroups = [];
    foreach ($fkRows as $fk) {
        $fkId = (int)$fk['id'];
        if (!isset($fkGroups[$fkId])) {
            $fkGroups[$fkId] = [
                'table' => (string)$fk['table'],
                'onDelete' => (string)$fk['on_delete'],
                'onUpdate' => (string)$fk['on_update'],
                'from' => [],
                'to' => [],
            ];
        }
        $fkGroups[$fkId]['from'][(int)$fk['seq']] = (string)$fk['from'];
        $fkGroups[$fkId]['to'][(int)$fk['seq']] = (string)$fk['to'];
    }
    foreach ($fkGroups as $g) {
        ksort($g['from']);
        ksort($g['to']);
        $fkClause = 'FOREIGN KEY (' . implode(', ', array_map('quoteIdent', $g['from'])) . ')'
            . ' REFERENCES ' . quoteIdent($g['table'])
            . ' (' . implode(', ', array_map('quoteIdent', $g['to'])) . ')';
        if ($g['onDelete'] && strtoupper($g['onDelete']) !== 'NO ACTION') {
            $fkClause .= ' ON DELETE ' . $g['onDelete'];
        }
        if ($g['onUpdate'] && strtoupper($g['onUpdate']) !== 'NO ACTION') {
            $fkClause .= ' ON UPDATE ' . $g['onUpdate'];
        }
        $colDefs[] = $fkClause;
    }

    $tmpName = '__dp_rebuild_' . bin2hex(random_bytes(6));
    $qTmp = quoteIdent($tmpName);
    $suffix = $withoutRowId ? ' WITHOUT ROWID' : '';

    $ownsTx = !$pdo->inTransaction();
    if ($ownsTx) {
        $pdo->exec('PRAGMA foreign_keys = OFF');
        $pdo->beginTransaction();
    }
    try {
        $pdo->exec("CREATE TABLE {$qTmp} (\n  " . implode(",\n  ", $colDefs) . "\n){$suffix}");
        $colList = implode(', ', $colNames);
        $selList = implode(', ', $selectExprs);
        $pdo->exec("INSERT INTO {$qTmp} ({$colList}) SELECT {$selList} FROM {$qTable}");
        $pdo->exec("DROP TABLE {$qTable}");
        $pdo->exec("ALTER TABLE {$qTmp} RENAME TO {$qTable}");
        foreach ($indexes as $idx) {
            if (!empty($idx['sql'])) {
                $pdo->exec((string)$idx['sql']);
            }
        }
        foreach ($triggers as $trg) {
            if (!empty($trg['sql'])) {
                $pdo->exec((string)$trg['sql']);
            }
        }
        $fkCheck = $pdo->query("PRAGMA foreign_key_check({$qTable})")->fetchAll();
        if (count($fkCheck) > 0) {
            throw new RuntimeException('Foreign key integrity check failed after column update');
        }
        if ($ownsTx) {
            $pdo->commit();
        }
    } catch (Throwable $e) {
        if ($ownsTx) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $pdo->exec('PRAGMA foreign_keys = ON');
        }
        throw $e;
    }
    if ($ownsTx) {
        $pdo->exec('PRAGMA foreign_keys = ON');
    }
}

function handleUpdateColumn(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['table'] ?? '', 'table name');
    $obj = getObjectRecord($pdo, $tableName);
    if ($obj['type'] !== 'table') {
        throw new InvalidArgumentException('Cannot update columns of a view');
    }
    $oldName = validateIdentifier($req['oldName'] ?? '', 'existing column name');
    $cols = getTableColumns($pdo, $tableName);
    $currentCol = null;
    foreach ($cols as $c) {
        if ($c['name'] === $oldName) {
            $currentCol = $c;
            break;
        }
    }
    if ($currentCol === null) {
        throw new InvalidArgumentException("Column \"{$oldName}\" not found");
    }

    $next = $req['next'] ?? null;
    if (!is_array($next)) {
        throw new InvalidArgumentException('next column definition is required');
    }
    $newName = validateIdentifier($next['name'] ?? $oldName, 'new column name');
    if (strtolower($newName) !== strtolower($oldName)) {
        foreach ($cols as $c) {
            if (strtolower($c['name']) === strtolower($newName)) {
                throw new InvalidArgumentException("Column \"{$newName}\" already exists");
            }
        }
    }

    $newType = validateColumnType($next['type'] ?? $currentCol['type']);
    $newNotNull = array_key_exists('notNull', $next) ? !empty($next['notNull']) : $currentCol['notnull'];
    $defaultChanged = !empty($next['updateDefault']);
    $newDefaultSql = $defaultChanged
        ? formatDefaultSql($pdo, $next['defaultMode'] ?? 'none', $next['defaultValue'] ?? null)
        : $currentCol['defaultValue'];

    $defChanged =
        strtoupper($newType) !== strtoupper($currentCol['type'] !== '' ? $currentCol['type'] : 'TEXT') ||
        $newNotNull !== $currentCol['notnull'] ||
        $defaultChanged;

    $nullBackfillExpr = null;
    if ($defChanged && $newNotNull && !$currentCol['notnull']) {
        $nullCount = (int)$pdo->query(
            'SELECT COUNT(*) FROM ' . quoteIdent($tableName) . ' WHERE ' . quoteIdent($oldName) . ' IS NULL'
        )->fetchColumn();
        if ($nullCount > 0) {
            if ($newDefaultSql === null || strtoupper((string)$newDefaultSql) === 'NULL') {
                throw new InvalidArgumentException(
                    "Cannot set NOT NULL: {$nullCount} existing row(s) have NULL in \"{$oldName}\". Supply a non-NULL default value."
                );
            }
            $nullBackfillExpr = $newDefaultSql;
        }
    }

    if ($newName !== $oldName && !$defChanged) {
        // Fast native RENAME COLUMN if only name changed (updates indexes/views/triggers automatically)
        $pdo->exec(
            'ALTER TABLE ' . quoteIdent($tableName)
            . ' RENAME COLUMN ' . quoteIdent($oldName) . ' TO ' . quoteIdent($newName)
        );
    } elseif ($defChanged) {
        // Atomic rename (if any) + table rebuild inside one transaction so failures never leave partial state
        $pdo->exec('PRAGMA foreign_keys = OFF');
        $pdo->beginTransaction();
        try {
            if ($newName !== $oldName) {
                $pdo->exec(
                    'ALTER TABLE ' . quoteIdent($tableName)
                    . ' RENAME COLUMN ' . quoteIdent($oldName) . ' TO ' . quoteIdent($newName)
                );
            }
            rebuildTableForColumnUpdate(
                $pdo,
                $tableName,
                $newName,
                $newType,
                $newNotNull,
                $newDefaultSql,
                $nullBackfillExpr
            );
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $pdo->exec('PRAGMA foreign_keys = ON');
            throw $e;
        }
        $pdo->exec('PRAGMA foreign_keys = ON');
    }

    return ['ok' => true, 'table' => $tableName, 'column' => $newName];
}

function handleDropColumn(PDO $pdo, array $req): array
{
    $tableName = validateIdentifier($req['table'] ?? '', 'table name');
    $obj = getObjectRecord($pdo, $tableName);
    if ($obj['type'] !== 'table') {
        throw new InvalidArgumentException('Cannot drop columns from a view');
    }
    $colName = validateIdentifier($req['columnName'] ?? '', 'column name');
    $cols = getTableColumns($pdo, $tableName);
    if (count($cols) <= 1) {
        throw new InvalidArgumentException('Cannot drop the only remaining column (drop the table instead)');
    }
    $found = null;
    foreach ($cols as $c) {
        if ($c['name'] === $colName) {
            $found = $c;
            break;
        }
    }
    if ($found === null) {
        throw new InvalidArgumentException("Column \"{$colName}\" not found");
    }
    if ($found['pk'] > 0) {
        throw new InvalidArgumentException('Cannot drop a PRIMARY KEY column directly');
    }

    $pdo->exec('ALTER TABLE ' . quoteIdent($tableName) . ' DROP COLUMN ' . quoteIdent($colName));
    return ['ok' => true, 'table' => $tableName, 'droppedColumn' => $colName];
}

function stripSqlCommentsAndLiterals(string $sql): string
{
    $len = strlen($sql);
    $out = '';
    $i = 0;
    while ($i < $len) {
        $ch = $sql[$i];
        $next = $i + 1 < $len ? $sql[$i + 1] : '';

        // Line comment --
        if ($ch === '-' && $next === '-') {
            $i += 2;
            while ($i < $len && $sql[$i] !== "\n") {
                $i += 1;
            }
            $out .= ' ';
            continue;
        }
        // Block comment /* */
        if ($ch === '/' && $next === '*') {
            $i += 2;
            while ($i + 1 < $len && !($sql[$i] === '*' && $sql[$i + 1] === '/')) {
                $i += 1;
            }
            $i += 2;
            $out .= ' ';
            continue;
        }
        // Single, double, backtick quoted strings or [bracket] identifiers
        if ($ch === "'" || $ch === '"' || $ch === '`') {
            $quote = $ch;
            $i += 1;
            while ($i < $len) {
                if ($sql[$i] === $quote) {
                    if ($i + 1 < $len && $sql[$i + 1] === $quote) {
                        $i += 2;
                        continue;
                    }
                    $i += 1;
                    break;
                }
                $i += 1;
            }
            $out .= ' __LIT__ ';
            continue;
        }
        if ($ch === '[') {
            $i += 1;
            while ($i < $len && $sql[$i] !== ']') {
                $i += 1;
            }
            if ($i < $len) {
                $i += 1;
            }
            $out .= ' __LIT__ ';
            continue;
        }
        $out .= $ch;
        $i += 1;
    }
    return $out;
}

function splitSqlStatements(string $sql): array
{
    $len = strlen($sql);
    $stmts = [];
    $buf = '';
    $triggerDepth = 0;
    $inTrigger = false;
    $token = '';
    $lastKeyword = '';

    $flushToken = static function (string &$tok, string &$lastKw, bool &$inTrig, int &$trigDepth): void {
        if ($tok === '') {
            return;
        }
        $upper = strtoupper($tok);
        if ($lastKw === 'CREATE' && $upper === 'TRIGGER') {
            $inTrig = true;
        } elseif ($lastKw === 'CREATE' && ($upper === 'TEMP' || $upper === 'TEMPORARY')) {
            // keep CREATE pending
            $tok = '';
            return;
        }
        if ($inTrig) {
            if ($upper === 'BEGIN' || $upper === 'CASE') {
                $trigDepth += 1;
            } elseif ($upper === 'END' && $trigDepth > 0) {
                $trigDepth -= 1;
            }
        }
        $lastKw = $upper;
        $tok = '';
    };

    $i = 0;
    while ($i < $len) {
        $ch = $sql[$i];
        $next = $i + 1 < $len ? $sql[$i + 1] : '';

        if ($ch === '-' && $next === '-') {
            $flushToken($token, $lastKeyword, $inTrigger, $triggerDepth);
            $buf .= '--';
            $i += 2;
            while ($i < $len && $sql[$i] !== "\n") {
                $buf .= $sql[$i];
                $i += 1;
            }
            continue;
        }
        if ($ch === '/' && $next === '*') {
            $flushToken($token, $lastKeyword, $inTrigger, $triggerDepth);
            $buf .= '/*';
            $i += 2;
            while ($i + 1 < $len && !($sql[$i] === '*' && $sql[$i + 1] === '/')) {
                $buf .= $sql[$i];
                $i += 1;
            }
            if ($i + 1 < $len) {
                $buf .= '*/';
                $i += 2;
            } else {
                $i = $len;
            }
            continue;
        }
        if ($ch === "'" || $ch === '"' || $ch === '`') {
            $flushToken($token, $lastKeyword, $inTrigger, $triggerDepth);
            $q = $ch;
            $buf .= $q;
            $i += 1;
            while ($i < $len) {
                $buf .= $sql[$i];
                if ($sql[$i] === $q) {
                    if ($i + 1 < $len && $sql[$i + 1] === $q) {
                        $buf .= $sql[$i + 1];
                        $i += 2;
                        continue;
                    }
                    $i += 1;
                    break;
                }
                $i += 1;
            }
            continue;
        }
        if ($ch === '[') {
            $flushToken($token, $lastKeyword, $inTrigger, $triggerDepth);
            $buf .= '[';
            $i += 1;
            while ($i < $len) {
                $buf .= $sql[$i];
                if ($sql[$i] === ']') {
                    $i += 1;
                    break;
                }
                $i += 1;
            }
            continue;
        }

        if (ctype_alnum($ch) || $ch === '_') {
            $token .= $ch;
            $buf .= $ch;
            $i += 1;
            continue;
        }

        $flushToken($token, $lastKeyword, $inTrigger, $triggerDepth);

        if ($ch === ';' && (!$inTrigger || $triggerDepth === 0)) {
            if (trim(stripSqlCommentsAndLiterals($buf)) !== '') {
                $stmts[] = trim($buf);
            }
            $buf = '';
            $inTrigger = false;
            $triggerDepth = 0;
            $lastKeyword = '';
            $i += 1;
            continue;
        }

        $buf .= $ch;
        $i += 1;
    }

    $flushToken($token, $lastKeyword, $inTrigger, $triggerDepth);
    if (trim(stripSqlCommentsAndLiterals($buf)) !== '') {
        $stmts[] = trim($buf);
    }

    return $stmts;
}

function handleExecScript(PDO $pdo, array $req): array
{
    $sql = $req['sql'] ?? '';
    if (!is_string($sql) || trim($sql) === '') {
        throw new InvalidArgumentException('SQL script cannot be empty');
    }
    if (strlen($sql) > 512 * 1024) {
        throw new InvalidArgumentException('SQL script exceeds 512 KB limit');
    }

    $useTx = !array_key_exists('useTransaction', $req) || !empty($req['useTransaction']);
    $allowDangerous = !empty($req['allowDangerous']);

    $statements = splitSqlStatements($sql);
    if (count($statements) === 0) {
        throw new InvalidArgumentException('No executable SQL statements found');
    }
    if (count($statements) > 200) {
        throw new InvalidArgumentException('SQL script exceeds 200 statements per execution');
    }

    $warnings = [];
    $hasTxStatements = false;
    foreach ($statements as $idx => $stmtSql) {
        $norm = preg_replace('/\s+/', ' ', trim(stripSqlCommentsAndLiterals($stmtSql)));
        if (preg_match('/\b(ATTACH|DETACH)\b/i', $norm)) {
            throw new InvalidArgumentException('ATTACH / DETACH DATABASE is blocked in Database Studio');
        }
        if (preg_match('/\bLOAD_EXTENSION\s*\(/i', $norm)) {
            throw new InvalidArgumentException('load_extension() is blocked in Database Studio');
        }
        if (preg_match('/\bPRAGMA\s+(writable_schema|temp_store_directory|database_list)\b/i', $norm)) {
            throw new InvalidArgumentException('This PRAGMA directive is restricted in Database Studio');
        }
        if (preg_match('/^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM)\b/i', $norm)) {
            $hasTxStatements = true;
        }
        if (preg_match('/^\s*DROP\s+(TABLE|VIEW|INDEX|TRIGGER)\b/i', $norm, $m)) {
            $warnings[] = 'Statement #' . ($idx + 1) . ': ' . strtoupper($m[0]);
        } elseif (preg_match('/^\s*DELETE\s+FROM\b/i', $norm) && !preg_match('/\bWHERE\b/i', $norm)) {
            $warnings[] = 'Statement #' . ($idx + 1) . ': DELETE without WHERE clause';
        } elseif (preg_match('/^\s*UPDATE\b/i', $norm) && !preg_match('/\bWHERE\b/i', $norm)) {
            $warnings[] = 'Statement #' . ($idx + 1) . ': UPDATE without WHERE clause';
        }
    }

    if (count($warnings) > 0 && !$allowDangerous) {
        return [
            'ok' => true,
            'requiresConfirmation' => true,
            'warnings' => $warnings,
            'results' => [],
        ];
    }

    $manageTx = $useTx && !$hasTxStatements;
    if ($manageTx) {
        $pdo->beginTransaction();
    }

    $results = [];
    try {
        foreach ($statements as $idx => $stmtSql) {
            $t0 = microtime(true);
            try {
                $stmt = $pdo->prepare($stmtSql);
                if ($stmt === false) {
                    throw new RuntimeException('Failed to prepare SQL statement');
                }
                $stmt->execute();
                $colCount = $stmt->columnCount();
                if ($colCount > 0) {
                    $rows = [];
                    $truncated = false;
                    $rowIdx = 0;
                    $colNames = [];
                    for ($c = 0; $c < $colCount; $c += 1) {
                        $meta = $stmt->getColumnMeta($c);
                        $colNames[] = is_array($meta) && isset($meta['name']) ? (string)$meta['name'] : "col_{$c}";
                    }
                    // Use numeric fetch so duplicate column names in JOINs keep distinct positions cleanly
                    while (($numRow = $stmt->fetch(PDO::FETCH_NUM)) !== false) {
                        if ($rowIdx >= 500) {
                            $truncated = true;
                            break;
                        }
                        $rows[] = array_map('encodeCellValue', $numRow);
                        $rowIdx += 1;
                    }
                    $stmt->closeCursor();
                    $results[] = [
                        'index' => $idx + 1,
                        'sql' => $stmtSql,
                        'kind' => 'rows',
                        'columns' => $colNames,
                        'rows' => $rows,
                        'rowCount' => count($rows),
                        'truncated' => $truncated,
                        'durationMs' => (int)round((microtime(true) - $t0) * 1000),
                    ];
                } else {
                    $changes = $stmt->rowCount();
                    $results[] = [
                        'index' => $idx + 1,
                        'sql' => $stmtSql,
                        'kind' => 'mutation',
                        'changes' => $changes,
                        'durationMs' => (int)round((microtime(true) - $t0) * 1000),
                    ];
                }
            } catch (Throwable $stmtErr) {
                throw new RuntimeException(
                    'Statement #' . ($idx + 1) . ' failed: ' . $stmtErr->getMessage(),
                    0,
                    $stmtErr
                );
            }
        }
        if ($manageTx && $pdo->inTransaction()) {
            $pdo->commit();
        }
    } catch (Throwable $e) {
        if ($manageTx && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return [
        'ok' => true,
        'requiresConfirmation' => false,
        'rolledBack' => false,
        'results' => $results,
    ];
}

try {
    $reqPath = $argv[1] ?? '';
    if ($reqPath === '' || !is_file($reqPath)) {
        throw new InvalidArgumentException('Missing request file');
    }
    $raw = file_get_contents($reqPath);
    if ($raw === false) {
        throw new RuntimeException('Unable to read request file');
    }
    $req = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($req)) {
        throw new InvalidArgumentException('Invalid request JSON');
    }

    $dbPath = is_string($req['dbPath'] ?? null) ? $req['dbPath'] : '';
    if ($dbPath === '' || !is_file($dbPath)) {
        throw new InvalidArgumentException('Database file not found');
    }

    $pdo = new PDO('sqlite:' . $dbPath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec('PRAGMA busy_timeout = 5000;');
    $pdo->exec('PRAGMA journal_mode = WAL;');
    $pdo->exec('PRAGMA foreign_keys = ON;');

    $op = (string)($req['op'] ?? '');
    $res = match ($op) {
        'schema' => handleSchema($pdo, $req),
        'rows.list' => handleRowsList($pdo, $req),
        'rows.insert' => handleInsertRow($pdo, $req),
        'rows.update' => handleUpdateRow($pdo, $req),
        'rows.delete' => handleDeleteRows($pdo, $req),
        'table.create' => handleCreateTable($pdo, $req),
        'table.drop' => handleDropTable($pdo, $req),
        'columns.add' => handleAddColumn($pdo, $req),
        'columns.update' => handleUpdateColumn($pdo, $req),
        'columns.drop' => handleDropColumn($pdo, $req),
        'script.exec' => handleExecScript($pdo, $req),
        default => throw new InvalidArgumentException("Unsupported db operation: {$op}"),
    };

    respond($res, 0);
} catch (Throwable $e) {
    respond([
        'ok' => false,
        'error' => $e->getMessage(),
    ], 1);
}
