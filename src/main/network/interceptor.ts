import { anonymousRegisterInterceptor } from "./interceptors/anonymous";
import { updateBlocker } from "./interceptors/update";
import { NetworkInterceptorPipeline } from "./pipeline";

export const networkInterceptorPipeline = new NetworkInterceptorPipeline()
  .use(anonymousRegisterInterceptor)
  .use(updateBlocker);
