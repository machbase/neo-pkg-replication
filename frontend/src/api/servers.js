import { request } from "./client";

export const listServers = () => request("GET", "/server/list");

export const getServer = (name) => request("GET", `/server?name=${encodeURIComponent(name)}`);

export const createServer = (data) => request("POST", "/server", data);

export const updateServer = (name, data) => request("PUT", `/server?name=${encodeURIComponent(name)}`, data);

export const deleteServer = (name) => request("DELETE", `/server?name=${encodeURIComponent(name)}`);

// type별 server profile 기본 템플릿
// 응답: { profile: {...}, targetOnly }
export const getServerDefault = (type) =>
    request("GET", `/server/default?type=${encodeURIComponent(type)}`);

// 저장된 server 또는 미저장 profile 연결 테스트
// payload: { name } 또는 { profile }
// 응답: { mode, type, targetOnly, probe }
export const testServer = (payload) => request("POST", "/server/test", payload);

export const listTables = (server) => request("POST", "/table/list", { server });

export const listTableTags = ({ server, table, page = 1, size = 50 }) =>
    request("POST", "/table/tags", { server, table, page, size });
