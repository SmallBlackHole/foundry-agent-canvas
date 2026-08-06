import { readFile, readdir } from "node:fs/promises";

const PUBLIC_DIR = new URL("../public/", import.meta.url);

export function readClientModule(name) {
    return readFile(new URL(name, PUBLIC_DIR), "utf8");
}

export async function readAllClientSource() {
    const modules = await readdir(new URL("app/", PUBLIC_DIR));
    const sources = await Promise.all([
        readClientModule("app.js"),
        ...modules
            .filter((name) => name.endsWith(".js"))
            .sort()
            .map((name) => readClientModule(`app/${name}`)),
    ]);
    return sources.join("\n");
}
