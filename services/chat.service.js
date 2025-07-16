const { ChatOpenAI } = require("@langchain/openai");
const {
  ChatPromptTemplate,
  MessagesPlaceholder,
} = require("@langchain/core/prompts");
const { BufferMemory, ChatMessageHistory } = require("langchain/memory");
const { ConversationChain } = require("langchain/chains");
const { PineconeStore } = require("@langchain/pinecone");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const {
  createHistoryAwareRetriever,
} = require("langchain/chains/history_aware_retriever");
const { createRetrievalChain } = require("langchain/chains/retrieval");
const {
  createStuffDocumentsChain,
} = require("langchain/chains/combine_documents");

const llm = new ChatOpenAI({
  modelName: "gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0,
});

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);

const memoryDict = {};

const getOrCreateMemoryForSession = async (sessionId, pastMessages) => {
  if (!memoryDict[sessionId]) {
    memoryDict[sessionId] = new BufferMemory({
      memoryKey: "chat_history",
      chatHistory: new ChatMessageHistory(pastMessages),
      returnMessages: true,
    });
  }
  return memoryDict[sessionId];
};

const SYSTEM_PROMPT = `
You are "SolicitorSense", a UK legal assistant.

**Role:**
- Help users with UK legal questions using laws, cases, and provided documents.
- Maintain professionalism and be as helpful as possible.

**When unsure:**
- Say: "This is a general overview. For advice on your specific case, consult a solicitor."

**When clearly unrelated to law:**
- Say: "I focus on UK legal matters. For other topics, please consult a relevant expert."

**When documents or legal data are provided:**
- Use them to form a detailed, relevant response .

**Format each answer as:**
1. Legal principle or rule
2. Relevant law or case (if any)
3. Practical explanation
4. Suggested next step (if needed)

**Tone:**
- Professional, clear, and empathetic
- Avoid legal jargon unless necessary

**Greeting:**
Start first reply with: "Hello, I'm SolicitorSense, your UK legal assistant."
`.trim();

const RETRIEVAL_PROMPT = ChatPromptTemplate.fromMessages([
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  [
    "system",
    `
  You are a UK legal search expert.  
  Rewrite the user's message as a concise legal search query.
  
  **Guidelines:**
  - Use legal terms only
  - Remove greetings and filler
  - Always end query with "UK"
  
  **Examples:**
  "Can my landlord evict me?" → "landlord eviction rights housing act 1988 UK"  
  "My employer fired me after I complained" → "unfair dismissal whistleblower protection UK"
  
  Output only the final search phrase — no punctuation, no explanations.
  `.trim(),
  ],
]);

const legalChat = async ({ userInput, sessionId, pastMessages }) => {
  try {
    const sessionMemory = await getOrCreateMemoryForSession(
      sessionId,
      pastMessages
    );

    // Setup vector retriever
    const vectorStore = await PineconeStore.fromExistingIndex(
      new OpenAIEmbeddings({ apiKey: process.env.OPENAI_API_KEY }),
      {
        pineconeIndex,
      }
    );

    const baseRetriever = vectorStore.asRetriever({ k: 5 });

    const historyAwareRetriever = await createHistoryAwareRetriever({
      llm,
      retriever: baseRetriever,
      rephrasePrompt: RETRIEVAL_PROMPT,
    });


    // Combine retrieved documents into a response
    const combineDocsChain = await createStuffDocumentsChain({
      llm,
      prompt: ChatPromptTemplate.fromMessages([
        ["system", SYSTEM_PROMPT],
        new MessagesPlaceholder("chat_history"),
        [
          "human",
          "Use the following legal documents to answer the question.\n\n{context}\n\nQuestion: {input}",
        ],
      ]),
    });

    const retrievalChain = await createRetrievalChain({
      retriever: historyAwareRetriever,
      combineDocsChain,
    });

    // Run RAG pipeline
    const ragResult = await retrievalChain.invoke({
      input: userInput,
      chat_history: await sessionMemory.chatHistory.getMessages(),
    });

    const { answer, context = [] } = ragResult;
    
    const hasSources = context.length > 0;

    if (hasSources) {
      await sessionMemory.chatHistory.addUserMessage(userInput);
      await sessionMemory.chatHistory.addAIMessage(answer);

      return {
        text: answer,
        sources: [
          ...new Set(
            context.map((doc) => doc.metadata?.source).filter(Boolean)
          ),
        ],
      };
    }

    // Fallback: standard LLM response
    const fallbackChain = new ConversationChain({
      memory: sessionMemory,
      prompt: ChatPromptTemplate.fromMessages([
        ["system", SYSTEM_PROMPT],
        new MessagesPlaceholder("chat_history"),
        ["human", "{input}"],
      ]),
      llm,
    });

    const fallbackResult = await fallbackChain.invoke({ input: userInput });

    await sessionMemory.chatHistory.addUserMessage(userInput);
    await sessionMemory.chatHistory.addAIMessage(fallbackResult.response);

    return {
      text: fallbackResult.response,
      sources: [],
      fallback: true,
    };
  } catch (error) {
    console.error("Error in legalChat:", error);
    throw new Error("Failed to process legal query");
  }
};

module.exports = {
  legalChat,
  getOrCreateMemoryForSession,
};
