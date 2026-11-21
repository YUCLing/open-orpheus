import { anonymousRegisterInterceptor } from "./interceptors/anonymous";
import { NetworkInterceptorPipeline } from "./pipeline";

export const networkInterceptorPipeline = new NetworkInterceptorPipeline().use(
  anonymousRegisterInterceptor
);
