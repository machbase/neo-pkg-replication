import { request } from "./client";

export const listLogFiles = async (name) => {
    const qs = name ? `?${new URLSearchParams({ name }).toString()}` : "";
    const data = await request("GET", `/log/list${qs}`);
    return data?.files ?? [];
};

export const fetchLogContentAll = async ({ name }) => {
    const params = new URLSearchParams({ name });
    return request("GET", `/log/content/all?${params.toString()}`);
};
