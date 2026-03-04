import { registerCallHandler } from "../calls";

// TODO: Implement this properly?
registerCallHandler<
  [],
  [
    {
      maxFailCount: number;
      nativeReportPercent: number;
      normalReportPercent: number;
      supportRPC: boolean;
    },
  ]
>("network.init", () => [
  {
    maxFailCount: 40,
    nativeReportPercent: 0,
    normalReportPercent: 0,
    supportRPC: true,
  },
]);
