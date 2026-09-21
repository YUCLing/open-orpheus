/**
 * Vite plugin that mocks the AWS S3 SDK out.
 */
export default function NoS3Plugin() {
  return {
    name: "no-s3",
    resolveId(id: string) {
      if (id === "@aws-sdk/client-s3") {
        return id; // Mark as resolved but empty
      }
    },
    load(id: string) {
      if (id === "@aws-sdk/client-s3") {
        return "export default {}"; // Provide an empty module
      }
    },
  };
}
