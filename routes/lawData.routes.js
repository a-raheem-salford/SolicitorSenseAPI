const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");
const OpenAI = require("openai");
const { Pinecone } = require("@pinecone-database/pinecone");

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);

const xmlLinks = [
  "https://www.legislation.gov.uk/ukpga/1974/37/data.xml",
];

function flattenXmlToText(obj) {
  let result = "";
  for (const key in obj) {
    if (key === "$") continue; // ignore attributes
    if (typeof obj[key] === "string") {
      result += obj[key] + " ";
    } else if (Array.isArray(obj[key])) {
      obj[key].forEach((item) => {
        result += flattenXmlToText(item);
      });
    } else if (typeof obj[key] === "object") {
      result += flattenXmlToText(obj[key]);
    }
  }
  return result;
}

function chunkText(text, maxLength = 2000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

// Your ORIGINAL route — keep as-is
router.get("/", async (req, res) => {
  try {
    const allChunks = [];
    for (const url of xmlLinks) {
      console.log(`Fetching: ${url}`);
      const pdfUrl = url.replace(/\.xml$/, ".pdf");
      const { data: xmlData } = await axios.get(url);
      const parsed = await xml2js.parseStringPromise(xmlData);
      const text = flattenXmlToText(parsed).replace(/\s+/g, " ").trim();

      const chunks = chunkText(text);

      console.log(`Parsed & chunked: ${chunks.length} chunks.`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunk,
        });

        await pineconeIndex.upsert([
          {
            id: `${url}-chunk-${i}`,
            values: embedding.data[0].embedding,
            metadata: { text: chunk, source: pdfUrl },
          },
        ]);

        allChunks.push({
          id: `${url}-chunk-${i}`,
          text: chunk,
          source: pdfUrl,
        });
        console.log(`Stored chunk ${i + 1} in Pinecone`);
      }
    }
    fs.writeFileSync("chunks.json", JSON.stringify(allChunks, null, 2));

    res.send("All XML files processed & stored in Pinecone!");
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send(`Error processing XML: ${err.message}`);
  }
});

module.exports = router;
