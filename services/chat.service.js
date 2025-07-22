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
  createStuffDocumentsChain,
} = require("langchain/chains/combine_documents");
const { Document } = require("langchain/document");

const llm = new ChatOpenAI({
  modelName: "gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.1,
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
You are "SolicitorSense", a comprehensive UK legal assistant.

**Your Expertise:**
- Employment law (Employment Rights Act 1996, Working Time Regulations 1998, Employment Relations Act 1999, Employment Act 2002)
- Health and safety law (Health and Safety at Work Act 1974)
- Equality and discrimination law (Equality Act 2010)
- Human rights law (Human Rights Act 1998)
- Criminal law (Coroners and Justice Act 2009)
- General UK statutory law and regulations

**Response Structure:**
1. **Direct Answer**: Address the specific legal question clearly
2. **Legal Authority**: Cite the relevant Act, section, or regulation
3. **Practical Application**: Explain what this means in real-world terms  
4. **Key Requirements**: Highlight specific legal duties, rights, or obligations
5. **Additional Considerations**: Note any exceptions, related provisions, or practical factors
6. **Next Steps**: Suggest appropriate actions where relevant

**Citation Standards:**
- Always cite specific provisions: "Under Section 1 of the Employment Rights Act 1996..."
- Reference the correct Act: "The Equality Act 2010 provides that..."
- Distinguish between different types of law: "This is a statutory right under..." vs "This is a common law principle..."
- Quote key definitions when relevant

**Legal Concepts to Explain:**
- Employment: unfair dismissal, redundancy, working time, discrimination, contracts
- Health & Safety: employer duties, employee obligations, risk assessment, enforcement
- Equality: protected characteristics, direct/indirect discrimination, harassment, reasonable adjustments
- Human Rights: fundamental rights, public authority duties, compatibility with UK law
- Criminal: offences, sentencing, procedural rights

**Professional Guidelines:**
- Distinguish between legal requirements and best practices
- Explain legal tests: "reasonable", "proportionate", "necessary", "practicable"
- Note when specialist advice is needed: "This is general guidance. For advice on your specific situation, please consult a qualified solicitor specializing in [area] law."
- For non-UK law queries: "I specialize in UK law. For other jurisdictions, please consult the appropriate legal expert."

**Tone:**
- Professional yet accessible
- Clear explanations without unnecessary jargon
- Helpful and practical
- Acknowledge complexity where it exists

**First Interaction:**
Start with: "Hello, I'm SolicitorSense, your UK legal assistant."
`.trim();

// Enhanced query preprocessing for different areas of UK law
function enhanceUKLegalQuery(query) {
  const legalTerms = {
    // Employment Law
    'unfair dismissal': 'unfair dismissal Employment Rights Act 1996 Section 94 qualifying period',
    'redundancy': 'redundancy consultation selection criteria Employment Rights Act 1996',
    'working time': 'working time 48 hours rest breaks holidays Working Time Regulations 1998',
    'maternity leave': 'maternity leave statutory pay Employment Rights Act 1996 Section 71',
    'holiday pay': 'holiday pay annual leave entitlement Working Time Regulations 1998',
    'notice period': 'notice period termination Employment Rights Act 1996 Section 86',
    'employment contract': 'employment contract terms conditions Employment Rights Act 1996',
    
    // Health and Safety
    'workplace safety': 'workplace safety employer duties Health Safety Work Act 1974 Section 2',
    'risk assessment': 'risk assessment hazards control measures reasonably practicable',
    'health safety policy': 'health safety policy statement Health Safety Work Act 1974',
    'safety training': 'safety training information instruction supervision Section 2',
    
    // Equality Law
    'discrimination': 'discrimination direct indirect Equality Act 2010 protected characteristics',
    'harassment': 'harassment unwanted conduct dignity Equality Act 2010 Section 26',
    'reasonable adjustments': 'reasonable adjustments disability Equality Act 2010 Section 20',
    'equal pay': 'equal pay sex equality clause Equality Act 2010 Section 66',
    'protected characteristics': 'age disability gender race religion sex Equality Act 2010',
    
    // Human Rights
    'human rights': 'human rights fundamental freedoms Human Rights Act 1998 ECHR',
    'fair trial': 'fair trial Article 6 Human Rights Act 1998 due process',
    'privacy': 'privacy private family life Article 8 Human Rights Act 1998',
    'freedom expression': 'freedom expression Article 10 Human Rights Act 1998',
    
    // General Legal Terms
    'statutory rights': 'statutory rights legislation parliament primary secondary',
    'legal duty': 'legal duty obligation requirement breach liability',
    'reasonable': 'reasonable practicable objective standard test',
    'tribunal': 'employment tribunal industrial tribunal procedure'
  };
  
  let enhancedQuery = query.toLowerCase();
  
  // Apply legal expansions
  for (const [key, expansion] of Object.entries(legalTerms)) {
    if (enhancedQuery.includes(key.replace(' ', '')) || enhancedQuery.includes(key)) {
      enhancedQuery += ' ' + expansion;
    }
  }
  
  // Add general UK legal context
  enhancedQuery += ' UK law legal statute regulation Act';
  
  return enhancedQuery;
}

// Direct Pinecone search with better control and filtering
async function searchPineconeDirectly(query, topK = 5, filter = null) {
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: "text-embedding-3-small"
  });
  
  // Generate embedding for the query
  const queryEmbedding = await embeddings.embedQuery(query);
  
  // Search in Pinecone with optional filtering
  const searchParams = {
    vector: queryEmbedding,
    topK: topK,
    includeMetadata: true
  };
  
  if (filter) {
    searchParams.filter = filter;
  }
  
  const searchResults = await pineconeIndex.query(searchParams);
  
  // Convert to LangChain Document format
  const documents = searchResults.matches.map(match => new Document({
    pageContent: match.metadata?.text || '',
    metadata: {
      id: match.id,
      score: match.score,
      source: match.metadata?.source,
      act_title: match.metadata?.act_title,
      legislation_type: match.metadata?.legislation_type,
      legislation_year: match.metadata?.legislation_year,
      section_context: match.metadata?.section_context,
      chunk_index: match.metadata?.chunk_index
    }
  }));
  
  return { documents, scores: searchResults.matches.map(m => m.score) };
}

// Intelligent search strategy based on query analysis
async function performIntelligentSearch(userInput) {
  const searches = [];
  
  // 1. Direct semantic search
  searches.push(searchPineconeDirectly(userInput, 3));
  
  // 2. Enhanced search with legal terms
  searches.push(searchPineconeDirectly(enhanceUKLegalQuery(userInput), 3));
  
  // 3. Targeted searches based on query content
  const queryLower = userInput.toLowerCase();
  
  if (queryLower.includes('employ') || queryLower.includes('work') || queryLower.includes('job')) {
    searches.push(searchPineconeDirectly(userInput, 2, { legislation_type: 'employment' }));
  }
  
  if (queryLower.includes('discriminat') || queryLower.includes('equal') || queryLower.includes('bias')) {
    searches.push(searchPineconeDirectly(userInput, 2, { legislation_type: 'equality' }));
  }
  
  if (queryLower.includes('safety') || queryLower.includes('health') || queryLower.includes('risk')) {
    searches.push(searchPineconeDirectly(userInput, 2, { legislation_type: 'health_safety' }));
  }
  
  if (queryLower.includes('human rights') || queryLower.includes('freedom') || queryLower.includes('privacy')) {
    searches.push(searchPineconeDirectly(userInput, 2, { legislation_type: 'human_rights' }));
  }
  
  // 4. Year-based search for recent legislation
  if (queryLower.includes('recent') || queryLower.includes('new') || queryLower.includes('latest')) {
    searches.push(searchPineconeDirectly(userInput, 2, { 
      legislation_year: { $gte: 2000 } 
    }));
  }
  
  // Execute all searches in parallel
  const results = await Promise.all(searches);
  
  return results;
}

const legalChat = async ({ userInput, sessionId, pastMessages }) => {
  try {
    console.log(`Processing legal query: "${userInput}"`);
    
    const sessionMemory = await getOrCreateMemoryForSession(
      sessionId,
      pastMessages
    );

    // Perform intelligent multi-strategy search
    const searchResults = await performIntelligentSearch(userInput);
    
    // Combine and deduplicate results
    const allDocs = [];
    const allScores = [];
    const seenIds = new Set();
    
    searchResults.forEach(({ documents, scores }) => {
      documents.forEach((doc, idx) => {
        if (!seenIds.has(doc.metadata.id)) {
          seenIds.add(doc.metadata.id);
          allDocs.push(doc);
          allScores.push(scores[idx]);
        }
      });
    });
    
    // Sort by score and take top results
    const sortedResults = allDocs
      .map((doc, idx) => ({ doc, score: allScores[idx] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    
    const bestScore = sortedResults[0]?.score || 0;
    const legislationTypes = [...new Set(sortedResults.map(r => r.doc.metadata.legislation_type).filter(Boolean))];
    
    console.log(`Search results: ${sortedResults.length} docs, best score: ${bestScore.toFixed(3)}, types: ${legislationTypes.join(', ')}`);
    
    // Dynamic threshold based on query complexity and results diversity
    const queryComplexity = userInput.split(' ').length;
    const hasMultipleTypes = legislationTypes.length > 1;
    const SCORE_THRESHOLD = queryComplexity > 10 || hasMultipleTypes ? 0.50 : 0.55;
    
    const strongMatches = sortedResults.filter(result => result.score >= SCORE_THRESHOLD);
    
    if (strongMatches.length > 0) {
      console.log(`Found ${strongMatches.length} matches above threshold ${SCORE_THRESHOLD}`);
      
      const relevantDocs = strongMatches.map(result => result.doc);
      
      // Create context summary for better responses
      const legislationContext = strongMatches.reduce((acc, result) => {
        const type = result.doc.metadata.legislation_type;
        const title = result.doc.metadata.act_title;
        if (!acc[type]) acc[type] = new Set();
        acc[type].add(title);
        return acc;
      }, {});
      
      const contextSummary = Object.entries(legislationContext)
        .map(([type, titles]) => `${type}: ${Array.from(titles).join(', ')}`)
        .join('; ');
      
      const ragPrompt = ChatPromptTemplate.fromMessages([
        ["system", SYSTEM_PROMPT + `\n\nCONTEXT: You have access to relevant provisions from: ${contextSummary}`],
        new MessagesPlaceholder("chat_history"),
        [
          "human",
          `Based on the following UK legislation provisions, please provide a comprehensive answer to the user's question.

RELEVANT LEGAL PROVISIONS:
{context}

USER QUESTION: {input}

Please structure your response with clear legal authority, practical explanation, and specific guidance. Always cite the relevant Acts and sections where applicable.`
        ],
      ]);

      const combineDocsChain = await createStuffDocumentsChain({
        llm,
        prompt: ragPrompt,
      });

      const ragResult = await combineDocsChain.invoke({
        input: userInput,
        context: relevantDocs,
        chat_history: await sessionMemory.chatHistory.getMessages(),
      });

      await sessionMemory.chatHistory.addUserMessage(userInput);
      await sessionMemory.chatHistory.addAIMessage(ragResult);

      // Extract comprehensive sources with legislation details
      const sources = [
        ...new Set(
          relevantDocs.map(doc => {
            const source = doc.metadata?.source;
            const title = doc.metadata?.act_title;
            const section = doc.metadata?.section_context;
            const year = doc.metadata?.legislation_year;
            
            let sourceString = title;
            if (year) sourceString += ` (${year})`;
            if (section && section !== 'General') sourceString += ` - ${section}`;
            
            return sourceString;
          }).filter(Boolean)
        ),
      ];

      return {
        text: ragResult,
        sources,
        confidence: 'high',
        matchedChunks: strongMatches.length,
        bestScore: bestScore,
        legislationTypes: legislationTypes,
        searchStrategy: 'intelligent_multi_strategy'
      };
    }

    console.log(`No strong matches found (best: ${bestScore.toFixed(3)}). Using enhanced fallback.`);
    
    // Enhanced fallback that categorizes the query and provides general guidance
    const queryCategory = categorizeQuery(userInput);
    const contextualFallback = sortedResults.slice(0, 2).map(result => {
      const title = result.doc.metadata.act_title;
      const content = result.doc.pageContent.substring(0, 300);
      return `From ${title}: ${content}...`;
    }).join('\n\n');

    const fallbackPrompt = ChatPromptTemplate.fromMessages([
      ["system", SYSTEM_PROMPT + `\n\nNote: Limited specific provisions were found for this query. The query appears to relate to ${queryCategory}. Provide general UK legal guidance in this area, using any available context carefully.`],
      new MessagesPlaceholder("chat_history"),
      ["human", contextualFallback ? `Some potentially relevant context:\n${contextualFallback}\n\nQuestion: {input}` : "{input}"],
    ]);

    const fallbackChain = new ConversationChain({
      memory: sessionMemory,
      prompt: fallbackPrompt,
      llm,
    });

    const fallbackResult = await fallbackChain.invoke({ input: userInput });

    await sessionMemory.chatHistory.addUserMessage(userInput);
    await sessionMemory.chatHistory.addAIMessage(fallbackResult.response);

    return {
      text: fallbackResult.response,
      sources: [],
      confidence: 'medium',
      fallback: true,
      bestScore: bestScore,
      queryCategory: queryCategory,
      availableContext: sortedResults.length > 0
    };
    
  } catch (error) {
    console.error("Error in legalChat:", error);
    throw new Error(`Failed to process legal query: ${error.message}`);
  }
};

// Categorize queries to provide better fallback responses
function categorizeQuery(query) {
  const categories = {
    'employment law': ['employ', 'job', 'work', 'dismiss', 'redundan', 'contract', 'wage', 'salary', 'holiday', 'maternity', 'notice'],
    'health and safety law': ['safety', 'health', 'risk', 'hazard', 'accident', 'injury', 'workplace', 'equipment'],
    'equality and discrimination law': ['discriminat', 'equal', 'bias', 'harassment', 'disability', 'race', 'sex', 'age', 'religion'],
    'human rights law': ['human rights', 'freedom', 'privacy', 'fair trial', 'expression', 'assembly', 'liberty'],
    'criminal law': ['criminal', 'offence', 'crime', 'sentence', 'prosecution', 'court', 'penalty'],
    'general civil law': ['contract', 'tort', 'negligence', 'liability', 'damages', 'breach']
  };
  
  const queryLower = query.toLowerCase();
  
  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(keyword => queryLower.includes(keyword))) {
      return category;
    }
  }
  
  return 'general UK law';
}



module.exports = {
  legalChat,
  getOrCreateMemoryForSession,
};