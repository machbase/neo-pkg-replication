import { request } from "./client";

export const listLogFiles = async () => {
    const data = await request("GET", "/log/list");
    return data?.files ?? [];
};

export const fetchLogContentAll = async ({ name }) => {
    const params = new URLSearchParams({ name });
    return request("GET", `/log/content/all?${params.toString()}`);
};
