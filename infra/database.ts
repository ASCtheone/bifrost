export const table = new sst.aws.Dynamo("BifrostTable", {
  fields: {
    PK: "string",
    SK: "string",
    GSI1PK: "string",
    GSI1SK: "string",
    GSI2PK: "string",
    GSI2SK: "string",
    GSI3PK: "string",
    GSI3SK: "string",
  },
  primaryIndex: { hashKey: "PK", rangeKey: "SK" },
  globalIndexes: {
    GSI1: { hashKey: "GSI1PK", rangeKey: "GSI1SK" },
    GSI2: { hashKey: "GSI2PK", rangeKey: "GSI2SK" },
    GSI3: { hashKey: "GSI3PK", rangeKey: "GSI3SK" },
  },
  stream: "new-and-old-images",
});

export const database = table;
