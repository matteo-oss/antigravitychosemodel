import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Every test process gets its own database/config. No real user data is touched.
process.env.AG_GATEWAY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gateway-test-'));
process.env.LOG_LEVEL = 'error';
