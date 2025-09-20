import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

export const panelDB = await mysql.createPool({
  host: process.env.PANEL_DB_HOST,
  port: process.env.PANEL_DB_PORT || 3306,
  user: process.env.PANEL_DB_USER,
  password: process.env.PANEL_DB_PASS,
  database: process.env.PANEL_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 60000,
  acquireTimeout: 60000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});
