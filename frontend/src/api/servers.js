import { request } from "./client";

export const listServers = () => request("GET", "/server/list");

export const getServer = (name) => request("GET", `/server?name=${encodeURIComponent(name)}`);

export const createServer = (data) => request("POST", "/server", data);

export const updateServer = (name, data) => request("PUT", `/server?name=${encodeURIComponent(name)}`, data);

export const deleteServer = (name) => request("DELETE", `/server?name=${encodeURIComponent(name)}`);

export const listTables = (server) => request("POST", "/table/list", { server });
