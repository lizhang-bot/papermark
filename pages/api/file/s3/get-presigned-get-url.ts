import { NextApiRequest, NextApiResponse } from "next";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl as getCloudfrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";

import { ONE_HOUR, ONE_SECOND, TWO_MINUTES } from "@/lib/constants";
import { getTeamS3ClientAndConfig } from "@/lib/files/aws-client";
import { log } from "@/lib/utils";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  // Extract the API Key from the Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1]; // Assuming the format is "Bearer [token]"

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Check if the API Key matches
  if (!process.env.INTERNAL_API_KEY) {
    log({
      message: "INTERNAL_API_KEY environment variable is not set",
      type: "error",
    });
    return res.status(500).json({ message: "Server configuration error" });
  }
  if (token !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const {
    key,
    expiresIn: requestedExpiresIn,
    responseContentDisposition,
  } = req.body as {
    key: string;
    expiresIn?: number;
    responseContentDisposition?: string;
  };

  const expiration = Math.min(requestedExpiresIn || TWO_MINUTES, ONE_HOUR);

  try {
    // Extract teamId from key (format: teamId/docId/filename)
    const teamId = key.split("/")[0];
    if (!teamId) {
      log({
        message: `Invalid key format: ${key}`,
        type: "error",
      });
      return res.status(400).json({ error: "Invalid key format" });
    }

    const { client, config } = await getTeamS3ClientAndConfig(teamId);

    if (config.distributionHost) {
      // CloudFront signed URLs DO honor `response-content-disposition` if S3
      // is the origin and the distribution forwards that query param. The
      // catch is that `@aws-sdk/cloudfront-signer` mangles the encoding when
      // it parses the URL, so the resulting URL fails with AccessDenied.
      // Workaround: set the param via URL.searchParams (so it's part of the
      // signed policy) and then re-set it on the signed output to fix the
      // encoding.
      // See https://obviy.us/blog/cloudfront-signed-disposition/
      const distributionUrl = new URL(
        key,
        `https://${config.distributionHost}`,
      );
      if (responseContentDisposition) {
        distributionUrl.searchParams.set(
          "response-content-disposition",
          responseContentDisposition,
        );
      }

      const signed = getCloudfrontSignedUrl({
        url: distributionUrl.toString(),
        keyPairId: `${config.distributionKeyId}`,
        privateKey: `${config.distributionKeyContents}`,
        dateLessThan: new Date(Date.now() + expiration).toISOString(),
      });

      let url = signed;
      if (responseContentDisposition) {
        const fixed = new URL(signed);
        fixed.searchParams.set(
          "response-content-disposition",
          responseContentDisposition,
        );
        url = fixed.href;
      }

      return res.status(200).json({ url });
    }

    const getObjectCommand = new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ...(responseContentDisposition
        ? { ResponseContentDisposition: responseContentDisposition }
        : {}),
    });

    const url = await getS3SignedUrl(client, getObjectCommand, {
      expiresIn: expiration / ONE_SECOND,
    });

    return res.status(200).json({ url });
  } catch (error) {
    log({
      message: `Error getting presigned get url for ${key} \n\n ${error}`,
      type: "error",
    });
    return res
      .status(500)
      .json({ error: "AWS Cloudfront Signed URL Error", message: error });
  }
}
