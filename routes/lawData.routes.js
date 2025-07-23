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
  "https://www.legislation.gov.uk/ukpga/1996/18/data.xml", // Employment Rights Act 1996
  "https://www.legislation.gov.uk/uksi/1998/1833/made/data.xml", // Working Time Regulations 1998
  "https://www.legislation.gov.uk/ukpga/1998/39/data.xml", // Human Rights Act 1998
  "https://www.legislation.gov.uk/ukpga/1999/26/data.xml", // Employment Relations Act 1999
  "https://www.legislation.gov.uk/ukpga/2010/15/data.xml", // Equality Act 2010
  "https://www.legislation.gov.uk/ukpga/2002/22/data.xml", // Employment Act 2002
  "https://www.legislation.gov.uk/ukpga/2009/22/data.xml", // Coroners and Justice Act 2009
  "https://www.legislation.gov.uk/ukpga/1974/37/data.xml", // Health and Safety at Work Act 1974
];

// Map URL patterns to legislation details
const LEGISLATION_MAP = {
  "ukpga/1996/18": {
    title: "Employment Rights Act 1996",
    type: "employment",
    year: 1996,
  },
  "uksi/1998/1833": {
    title: "Working Time Regulations 1998",
    type: "employment",
    year: 1998,
  },
  "ukpga/1998/39": {
    title: "Human Rights Act 1998",
    type: "human_rights",
    year: 1998,
  },
  "ukpga/1999/26": {
    title: "Employment Relations Act 1999",
    type: "employment",
    year: 1999,
  },
  "ukpga/2010/15": { title: "Equality Act 2010", type: "equality", year: 2010 },
  "ukpga/2002/22": {
    title: "Employment Act 2002",
    type: "employment",
    year: 2002,
  },
  "ukpga/2009/22": {
    title: "Coroners and Justice Act 2009",
    type: "criminal",
    year: 2009,
  },
  "ukpga/1974/37": {
    title: "Health and Safety at Work Act 1974",
    type: "health_safety",
    year: 1974,
  },
};

// Get legislation info from URL
function getLegislationInfo(url) {
  for (const [pattern, info] of Object.entries(LEGISLATION_MAP)) {
    if (url.includes(pattern)) {
      return info;
    }
  }
  return { title: "Unknown Legislation", type: "general", year: null };
}

// Clean extraction that focuses on actual legal content
function extractCleanLegalContent(
  obj,
  context = { title: "", section: "", subsection: "" }
) {
  const results = [];

  function traverse(node, currentContext = context) {
    if (typeof node === "string" && node.trim()) {
      const cleanText = node.trim();
      // Only include meaningful text (filter out very short fragments)
      if (cleanText.length > 30 && !cleanText.match(/^[\d\s\.\(\)]+$/)) {
        results.push({
          content: cleanText,
          context: { ...currentContext },
        });
      }
      return;
    }

    if (typeof node !== "object" || node === null) return;

    // Handle arrays
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        traverse(item, { ...currentContext, arrayIndex: index });
      });
      return;
    }

    // Update context based on XML structure
    const newContext = { ...currentContext };

    // Extract titles and section information
    if (node.Title && Array.isArray(node.Title)) {
      const titleText = extractTextFromNode(node.Title[0]);
      if (titleText && titleText.length > 5) {
        newContext.section = titleText;
      }
    }

    // Handle different XML elements for different legislation types
    for (const [key, value] of Object.entries(node)) {
      if (key === "$" || key === "_") continue; // Skip attributes and empty elements

      // Update context for different elements
      let contextUpdate = { ...newContext };

      if (key === "LongTitle") {
        contextUpdate.section = "Purpose and Scope";
      } else if (key === "P1") {
        contextUpdate.subsection = "Section";
      } else if (key === "P2") {
        contextUpdate.subsection = "Subsection";
      } else if (key === "P3") {
        contextUpdate.subsection = "Paragraph";
      } else if (key === "Part") {
        contextUpdate.section = "Part";
      } else if (key === "Chapter") {
        contextUpdate.section = "Chapter";
      } else if (key === "Schedule") {
        contextUpdate.section = "Schedule";
      }

      traverse(value, contextUpdate);
    }
  }

  traverse(obj);
  return results;
}

// Helper function to extract clean text from XML node
function extractTextFromNode(node) {
  if (typeof node === "string") {
    return node.trim();
  }

  if (typeof node !== "object" || node === null) {
    return "";
  }

  if (Array.isArray(node)) {
    return node.map(extractTextFromNode).join(" ").trim();
  }

  let text = "";
  for (const [key, value] of Object.entries(node)) {
    if (key !== "$") {
      // Skip attributes
      text += " " + extractTextFromNode(value);
    }
  }

  return text.trim();
}

// Create coherent chunks from legal content
function createCoherentChunks(contentArray, maxLength = 1200) {
  const chunks = [];
  let currentChunk = {
    text: "",
    context: { title: "", section: "", subsection: "" },
    sources: [],
  };

  for (const item of contentArray) {
    const contentWithContext = formatContentWithContext(item);

    // If adding this content would exceed max length, save current chunk
    if (
      currentChunk.text.length + contentWithContext.length > maxLength &&
      currentChunk.text.trim()
    ) {
      chunks.push({
        text: currentChunk.text.trim(),
        context: currentChunk.context,
        sources: [...currentChunk.sources],
      });

      // Start new chunk with some context
      currentChunk = {
        text: contentWithContext,
        context: item.context,
        sources: [item.context],
      };
    } else {
      // Add to current chunk
      if (currentChunk.text) {
        currentChunk.text += "\n\n" + contentWithContext;
      } else {
        currentChunk.text = contentWithContext;
        currentChunk.context = item.context;
      }
      currentChunk.sources.push(item.context);
    }
  }

  // Add the final chunk
  if (currentChunk.text.trim()) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// Format content with minimal, clean context
function formatContentWithContext(item) {
  let contextPrefix = "";

  if (
    item.context.section &&
    !["Purpose and Scope", "General"].includes(item.context.section)
  ) {
    contextPrefix = `[${item.context.section}] `;
  }

  return contextPrefix + item.content;
}

// Process and clean legal text
function processLegalText(text) {
  return (
    text
      // Remove excessive whitespace
      .replace(/\s+/g, " ")
      // Fix common legal formatting issues
      .replace(/\s+([\.,:;])/g, "$1")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      // Ensure proper sentence spacing
      .replace(/([\.!?])\s*([A-Z])/g, "$1 $2")
      // Clean up section references
      .replace(/Section\s+(\d+)/gi, "Section $1")
      .replace(/Part\s+(\d+)/gi, "Part $1")
      .replace(/Chapter\s+(\d+)/gi, "Chapter $1")
      .replace(/Schedule\s+(\d+)/gi, "Schedule $1")
      .trim()
  );
}

// Generate clean, meaningful ID
function generateCleanId(legislationInfo, chunkIndex) {
  const typeMap = {
    employment: "EMP",
    health_safety: "HSW",
    human_rights: "HRA",
    equality: "EQL",
    criminal: "CRM",
    general: "GEN",
  };

  const prefix = typeMap[legislationInfo.type] || "LEG";
  const year = legislationInfo.year || "0000";
  const paddedIndex = chunkIndex.toString().padStart(3, "0");

  return `${prefix}_${year}_${paddedIndex}`;
}

// Main processing route with improved chunking
router.get("/", async (req, res) => {
  try {
    const allChunks = [];
    const processingStats = {
      total_documents: xmlLinks.length,
      processed: 0,
      chunks_created: 0,
      errors: [],
    };

    for (const url of xmlLinks) {
      try {
        const pdfUrl = url.replace(/\.xml$/, ".pdf");
        const legislationInfo = getLegislationInfo(url);

        // Fetch and parse XML
        const { data: xmlData } = await axios.get(url, { timeout: 30000 });
        const parsed = await xml2js.parseStringPromise(xmlData, {
          preserveChildrenOrder: true,
          explicitArray: true,
          explicitRoot: true,
        });

        console.log(` Processing: ${legislationInfo.title}`);

        // Extract title and basic info - handle different XML structures
        let title = legislationInfo.title;
        let longTitle = "";

        // Try different XML paths for title extraction
        const titlePaths = [
          parsed?.Legislation?.Primary?.[0]?.PrimaryPrelims?.[0]?.Title?.[0],
          parsed?.Legislation?.Secondary?.[0]?.SecondaryPrelims?.[0]
            ?.Title?.[0],
          parsed?.Legislation?.ukm?.[0]?.Metadata?.[0]?.Title?.[0],
        ];

        const longTitlePaths = [
          parsed?.Legislation?.Primary?.[0]?.PrimaryPrelims?.[0]
            ?.LongTitle?.[0],
          parsed?.Legislation?.Secondary?.[0]?.SecondaryPrelims?.[0]
            ?.LongTitle?.[0],
        ];

        for (const path of titlePaths) {
          if (path) {
            const extractedTitle = extractTextFromNode(path);
            if (extractedTitle && extractedTitle.length > title.length) {
              title = extractedTitle;
              break;
            }
          }
        }

        for (const path of longTitlePaths) {
          if (path) {
            longTitle = extractTextFromNode(path);
            if (longTitle) break;
          }
        }

        console.log(` Extracting content from: ${title}`);

        // Extract clean content
        const cleanContent = extractCleanLegalContent(parsed, {
          title: title,
          section: "",
          subsection: "",
        });

        if (cleanContent.length === 0) {
          console.log(` No content extracted from ${url}`);
          processingStats.errors.push(`No content: ${url}`);
          continue;
        }

        console.log(`Extracted ${cleanContent.length} content pieces`);

        // Create coherent chunks
        const coherentChunks = createCoherentChunks(cleanContent);

        console.log(`Created ${coherentChunks.length} coherent chunks`);

        // Process each chunk
        for (let i = 0; i < coherentChunks.length; i++) {
          const chunk = coherentChunks[i];

          // Build final text with proper structure
          let finalText = `${title}\n\n`;

          // Add long title for first chunk only
          if (i === 0 && longTitle && longTitle.length > 20) {
            finalText += `${longTitle}\n\n`;
          }

          // Add the main content
          finalText += processLegalText(chunk.text);

          // Generate embedding
          // const embedding = await openai.embeddings.create({
          //   model: "text-embedding-3-small",
          //   input: finalText,
          // });

          // Comprehensive metadata
          const metadata = {
            text: finalText,
            source: pdfUrl,
            original_url: url,
            act_title: title,
            legislation_type: legislationInfo.type,
            legislation_year: legislationInfo.year,
            section_context: chunk.context.section || "General",
            chunk_index: i,
            total_chunks: coherentChunks.length,
            content_type: "uk_legislation",
            processed_at: new Date().toISOString(),
            text_length: finalText.length,
          };

          // Create clean ID
          const cleanId = generateCleanId(legislationInfo, i);

          // await pineconeIndex.upsert([
          //   {
          //     id: cleanId,
          //     values: embedding.data[0].embedding,
          //     metadata
          //   },
          // ]);

          allChunks.push({
            id: cleanId,
            ...metadata,
          });

          console.log(
            ` Stored chunk ${i + 1}/${coherentChunks.length}: ${title} (${
              finalText.length
            } chars)`
          );

          // Small delay to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        processingStats.processed++;
        processingStats.chunks_created += coherentChunks.length;
      } catch (error) {
        console.log(` Error processing ${url}:`, error.message);
        processingStats.errors.push(`${url}: ${error.message}`);
      }
    }

    // Save clean chunks
    fs.writeFileSync(
      "uk_legislation_chunks.json",
      JSON.stringify(allChunks, null, 2)
    );

    // Generate comprehensive summary
    const summary = {
      ...processingStats,
      total_chunks: allChunks.length,
      average_length:
        allChunks.length > 0
          ? Math.round(
              allChunks.reduce((sum, chunk) => sum + chunk.length, 0) /
                allChunks.length
            )
          : 0,
      legislation_types: [...new Set(allChunks.map((chunk) => chunk.type))],
      years_covered: [...new Set(allChunks.map((chunk) => chunk.year))]
        .filter(Boolean)
        .sort(),
      acts_processed: [...new Set(allChunks.map((chunk) => chunk.act_title))],
      sections_covered: [
        ...new Set(
          allChunks.map((chunk) => chunk.sections_covered).filter(Boolean)
        ),
      ],
      processing_completed: new Date().toISOString(),
    };

    console.log("Processing Summary:", summary);

    res.json({
      message: "UK legislation processed with clean chunking!",
      summary,
      sample_chunk: allChunks[0]?.preview,
      sample_acts: allChunks
        .slice(0, 3)
        .map((c) => ({ title: c.act_title, type: c.type })),
    });
  } catch (err) {
    console.log("Global Error:", err);
    res.status(500).json({
      error: `Error processing legislation: ${err.message}`,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// Get statistics about processed legislation
router.get("/stats", async (req, res) => {
  try {
    const stats = await pineconeIndex.describeIndexStats();

    res.json({
      message: "📊 Legislation Database Statistics",
      pinecone_stats: stats,
      legislation_map: LEGISLATION_MAP,
      total_sources: xmlLinks.length,
    });
  } catch (err) {
    console.log("Error getting stats:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
