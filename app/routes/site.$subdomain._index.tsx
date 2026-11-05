import type { LoaderFunctionArgs } from "@remix-run/node";
import { loader as fileLoader } from "./site.$subdomain.$";

export async function loader(args: LoaderFunctionArgs) {
  // Delegate to file loader with index.html as the target file
  return fileLoader({
    ...args,
    params: {
      ...args.params,
      "*": "index.html",
    },
  });
}
