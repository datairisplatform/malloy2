/*
 * Copyright 2023 Google LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files
 * (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import snowflake, {
  SnowflakeError,
  Statement,
  Connection,
  ConnectionOptions,
} from 'snowflake-sdk';
import {Pool, Options as PoolOptions} from 'generic-pool';
import * as toml from 'toml';
import * as fs from 'fs';
import * as path from 'path';
import {Readable} from 'stream';
import {
  toAsyncGenerator,
  QueryData,
  QueryDataRow,
  RunSQLOptions,
} from '@malloydata/malloy';

export interface ConnectionConfigFile {
  // a toml file with snowflake connection settings
  // if not provided, we will try to read ~/.snowflake/config
  config_file_path?: string;
  // the name of connection in the config file
  // if not provided, we will try to use the "default" connection
  connection_name?: string;
}

function columnNameToLowerCase(row: QueryDataRow): QueryDataRow {
  const ret: QueryDataRow = {};
  for (const key in row) {
    ret[key.toLowerCase()] = row[key];
  }
  return ret;
}

export class SnowflakeExecutor {
  private static defaultPoolOptions_: PoolOptions = {
    min: 1,
    max: 1,
    // evictionRunIntervalMillis: 60_000, // default = 0, off
    // idleTimeoutMillis: 60_000, // default = 30000
  };
  private static defaultConnectionOptions = {
    clientSessionKeepAlive: true, // default = false
    clientSessionKeepAliveHeartbeatFrequency: 900, // default = 3600
  };

  private pool_: Pool<Connection>;
  constructor(connOptions: ConnectionOptions, poolOptions?: PoolOptions) {
    this.pool_ = snowflake.createPool(connOptions, {
      ...SnowflakeExecutor.defaultPoolOptions_,
      ...(poolOptions ?? {}),
    });
  }

  public static getConnectionOptionsFromToml(
    options?: ConnectionConfigFile
  ): ConnectionOptions {
    let location: string | undefined = options?.config_file_path;
    if (location === undefined) {
      const homeDir = process.env['HOME'] || process.env['USERPROFILE'];
      if (homeDir === undefined) {
        throw new Error('could not find a path to connections.toml');
      }
      location = path.join(homeDir, '.snowflake', 'connections.toml');
    }

    if (!fs.existsSync(location)) {
      throw new Error(
        `provided snowflake connection config file: ${location} does not exist`
      );
    }

    const tomlData = fs.readFileSync(location, 'utf-8');
    const connections = toml.parse(tomlData);
    const tomlConnectionName = options?.connection_name ?? 'default';
    const connection = connections[tomlConnectionName];
    if (connection === undefined) {
      throw new Error(
        `provided snowflake connection name: ${tomlConnectionName} does not exist at ${location}`
      );
    }

    // sometimes the connection file uses "user" instead of "username"
    // because the python api expects 'user'
    connection['username'] = connection['username'] ?? connection['user'];
    if (!connection || !connection.account || !connection.username) {
      throw new Error(
        `provided snowflake connection config file at ${location} is not valid`
      );
    }

    return {
      // some basic options we configure by default but can be overriden
      ...SnowflakeExecutor.defaultConnectionOptions,
      account: connection.account,
      username: connection.username,
      ...connection,
    };
  }

  public async done() {
    await this.pool_.drain().then(() => {
      this.pool_.clear();
    });
  }

  public async _execute(sqlText: string, conn: Connection): Promise<QueryData> {
    return new Promise((resolve, reject) => {
      const _statment = conn.execute({
        sqlText,
        complete: (
          err: SnowflakeError | undefined,
          _stmt: Statement,
          rows?: QueryData
        ) => {
          if (err) {
            reject(err);
          } else if (rows) {
            resolve(rows.map(columnNameToLowerCase));
          }
        },
      });
    });
  }

  private async _setSessionParams(conn: Connection) {
    // set some default session parameters
    // this is quite imporant for snowflake because malloy tends to add quotes to all database identifiers
    // and snowflake is case sensitive by with quotes but matches against all caps identifiers without quotes
    await this._execute(
      'ALTER SESSION SET QUOTED_IDENTIFIERS_IGNORE_CASE = true;',
      conn
    );
  }

  public async batch(sqlText: string): Promise<QueryData> {
    return await this.pool_.use(async (conn: Connection) => {
      await this._setSessionParams(conn);
      return await this._execute(sqlText, conn);
    });
  }

  public async stream(
    sqlText: string,
    options?: RunSQLOptions
  ): Promise<AsyncIterableIterator<QueryDataRow>> {
    const pool: Pool<Connection> = this.pool_;
    return await pool.acquire().then(async (conn: Connection) => {
      await this._setSessionParams(conn);
      const stmt: Statement = conn.execute({
        sqlText,
        streamResult: true,
      });
      const stream: Readable = stmt.streamRows();
      function streamSnowflake(
        onError: (error: Error) => void,
        onData: (data: QueryDataRow) => void,
        onEnd: () => void
      ) {
        function handleEnd() {
          onEnd();
          pool.release(conn);
        }

        let index = 0;
        function handleData(this: Readable, row: QueryDataRow) {
          onData(columnNameToLowerCase(row));
          index += 1;
          if (options?.rowLimit !== undefined && index >= options.rowLimit) {
            onEnd();
          }
        }
        stream.on('error', onError);
        stream.on('data', handleData);
        stream.on('end', handleEnd);
      }
      return Promise.resolve(toAsyncGenerator<QueryDataRow>(streamSnowflake));
    });
  }
}
