import { request } from "./client";

const RC = "/rc";

// list 응답: [{ name, installed, running }]
function mapListItem(j) {
    const { checkpoints, ...rest } = j;
    return { ...rest, id: j.name, installed: j.installed, status: j.running ? "running" : "stopped" };
}

export const listJobs = async () => {
    const data = await request("GET", `${RC}/list`);
    return data.map(mapListItem);
};

// 단건 응답: { name, config: { ... }, checkpoints: { ... } }
export const getJob = async (name) => {
    const data = await request("GET", `${RC}?name=${encodeURIComponent(name)}`);
    return { name: data.name, ...data.config, checkpoints: data.checkpoints };
};

export const createJob = (data) => request("POST", RC, data);

export const updateJob = (name, config) => request("PUT", `${RC}?name=${encodeURIComponent(name)}`, config);

export const deleteJob = (name) => request("DELETE", `${RC}?name=${encodeURIComponent(name)}`);

export const startJob = (name) => request("POST", `${RC}/start?name=${encodeURIComponent(name)}`);

export const stopJob = (name) => request("POST", `${RC}/stop?name=${encodeURIComponent(name)}`);

export const installJob = (name) => request("POST", `${RC}/install?name=${encodeURIComponent(name)}`);

// dry-run 검증 (저장 없이 config 검증)
// 응답: { source, target, normalized, warnings[] }
export const dryRunJob = (config) => request("POST", `${RC}/dryrun`, { config });

// replication create 기본 템플릿
// 응답: { config: {...}, guide: { requiredOnCreate, examples } }
export const getRcDefault = () => request("GET", `${RC}/default`);

// 테이블 컬럼 조회 - server 참조 방식
// body: { server: "name", table: "HOME" }
export const fetchTableColumns = ({ server, table }) => request("POST", "/table/columns", { server, table });
