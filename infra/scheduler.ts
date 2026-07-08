import { table } from "./database.js";

new sst.aws.Cron("AutoPromoteSchedule", {
  schedule: "rate(1 minute)",
  job: {
    handler: "apps/spark-lambda/src/handlers/auto-promote.handler",
    link: [table],
    environment: {
      TABLE_NAME: table.name,
    },
    timeout: "30 seconds",
  },
});
