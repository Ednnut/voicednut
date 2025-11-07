const EventEmitter = require('events');
const axios = require('axios');
const PersonaComposer = require('../services/PersonaComposer');

class EnhancedSmsService extends EventEmitter {
    constructor(options = {}) {
        super();
        const { provider = 'twilio', awsAdapter = null, twilioClient = null } = options;
        this.provider = provider;
        if (provider === 'twilio') {
            this.twilio = twilioClient || require('twilio')(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN
            );
        } else {
            this.twilio = twilioClient || null;
        }
        this.awsAdapter = awsAdapter || null;
        this.openai = new(require('openai'))({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: process.env.OPENROUTER_API_KEY,
            defaultHeaders: {
                "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost:3000",
                "X-Title": process.env.YOUR_SITE_NAME || "SMS AI Assistant",
            }
        });
        this.model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";

        // SMS conversation tracking
        this.activeConversations = new Map();
        this.messageQueue = new Map(); // Queue for outbound messages
        this.personaComposer = new PersonaComposer();
        this.defaultSmsPersona = {
            businessId: process.env.DEFAULT_SMS_BUSINESS_ID || null,
            purpose: 'customer_service',
            channel: 'sms',
            emotion: 'neutral',
            urgency: 'normal',
            technicalLevel: 'general'
        };
        this.db = null;
        this.vonageAdapter = null;
        this.builtinTemplates = {
            welcome: {
                name: 'welcome',
                description: 'Friendly greeting for new contacts',
                content: "Welcome to our service! We're excited to have you aboard. Reply HELP for assistance or STOP to unsubscribe.",
                is_builtin: true
            },
            appointment_reminder: {
                name: 'appointment_reminder',
                description: 'Notify about upcoming appointments',
                content: 'Reminder: You have an appointment on {date} at {time}. Reply CONFIRM to confirm or RESCHEDULE to change.',
                is_builtin: true
            },
            verification: {
                name: 'verification',
                description: 'Send one-time verification codes',
                content: 'Your verification code is: {code}. This code will expire in 10 minutes. Do not share this code with anyone.',
                is_builtin: true
            },
            order_update: {
                name: 'order_update',
                description: 'Inform customers about order status',
                content: 'Order #{order_id} update: {status}. Track your order at {tracking_url}',
                is_builtin: true
            },
            payment_reminder: {
                name: 'payment_reminder',
                description: 'Prompt users about pending payments',
                content: 'Payment reminder: Your payment of {amount} is due on {due_date}. Pay now: {payment_url}',
                is_builtin: true
            },
            promotional: {
                name: 'promotional',
                description: 'Broadcast limited-time promotions',
                content: '🎉 Special offer just for you! {offer_text} Use code {promo_code}. Valid until {expiry_date}. Reply STOP to opt out.',
                is_builtin: true
            },
            customer_service: {
                name: 'customer_service',
                description: 'Acknowledge support inquiries',
                content: "Thanks for contacting us! We've received your message and will respond within 24 hours. For urgent matters, call {phone}.",
                is_builtin: true
            },
            survey: {
                name: 'survey',
                description: 'Request post-interaction feedback',
                content: 'How was your experience with us? Rate us 1-5 stars by replying with a number. Your feedback helps us improve!',
                is_builtin: true
            }
        };
    }

    setDatabase(database) {
        this.db = database;
    }

    setSmsAdapter(adapter) {
        this.awsAdapter = adapter;
    }

    setProvider(provider, adapter = null) {
        this.provider = provider;
        if (provider === 'aws') {
            if (adapter) {
                this.awsAdapter = adapter;
            }
            this.vonageAdapter = null;
        } else if (provider === 'vonage') {
            if (adapter) {
                this.vonageAdapter = adapter;
            }
            if (!this.twilio) {
                this.twilio = require('twilio')(
                    process.env.TWILIO_ACCOUNT_SID,
                    process.env.TWILIO_AUTH_TOKEN
                );
            }
            this.awsAdapter = null;
        } else {
            this.awsAdapter = null;
            this.vonageAdapter = null;
            if (!this.twilio) {
                this.twilio = require('twilio')(
                    process.env.TWILIO_ACCOUNT_SID,
                    process.env.TWILIO_AUTH_TOKEN
                );
            }
        }
    }

    updateDefaultPersona(options = {}) {
        this.defaultSmsPersona = {
            ...this.defaultSmsPersona,
            ...options
        };
    }

    analyzeTone(message) {
        const text = (message || '').toLowerCase();
        let emotion = 'neutral';
        let urgency = 'normal';
        let technicalLevel = 'general';

        if (/(urgent|asap|immediately|right now|emergency|critical)/.test(text)) {
            emotion = 'urgent';
            urgency = 'high';
        } else if (/(frustrated|angry|annoyed|upset|mad|furious|disappointed)/.test(text)) {
            emotion = 'frustrated';
        } else if (/(confused|don't understand|lost|unclear|explain)/.test(text)) {
            emotion = 'confused';
        } else if (/(thanks|thank you|appreciate|great)/.test(text)) {
            emotion = 'positive';
        }

        if (/(security|fraud|breach|locked|hack)/.test(text)) {
            urgency = 'critical';
        } else if (/(deadline|due today|late fee)/.test(text)) {
            urgency = 'high';
        }

        if (/(stack trace|exception|deployment|api|server|database|config)/.test(text)) {
            technicalLevel = 'advanced';
        } else if (/(setup|install|how do i|step by step)/.test(text)) {
            technicalLevel = 'novice';
        }

        return { emotion, urgency, technicalLevel };
    }

    composeConversationContext(conversation, overrides = {}) {
        const normalized = { ...overrides };

        if (normalized.business_id && !normalized.businessId) {
            normalized.businessId = normalized.business_id;
        }
        if (normalized.purpose_id && !normalized.purpose) {
            normalized.purpose = normalized.purpose_id;
        }
        if (normalized.technical_level && !normalized.technicalLevel) {
            normalized.technicalLevel = normalized.technical_level;
        }

        normalized.channel = 'sms';

        const personaOptions = {
            ...(conversation.personaProfile || this.defaultSmsPersona),
            ...normalized
        };

        const composition = this.personaComposer.compose(personaOptions);
        conversation.context = composition.systemPrompt;
        conversation.persona = composition.metadata;
        conversation.personaProfile = {
            businessId: composition.metadata.businessId,
            purpose: composition.metadata.purpose,
            emotion: composition.metadata.emotion,
            urgency: composition.metadata.urgency,
            technicalLevel: composition.metadata.technicalLevel
        };
    }

    // Send individual SMS
    async sendSMS(to, message, from = null, personaOverrides = null) {
        try {
            const fromNumber = from || process.env.FROM_NUMBER;

            if (this.provider !== 'aws' && !fromNumber) {
                throw new Error('No FROM_NUMBER configured for SMS');
            }

            let conversation = this.activeConversations.get(to);
            if (!conversation) {
                conversation = {
                    phone: to,
                    messages: [],
                    created_at: new Date(),
                    last_activity: new Date(),
                    personaProfile: { ...this.defaultSmsPersona }
                };
                this.activeConversations.set(to, conversation);
            }

            if (personaOverrides || !conversation.context) {
                this.composeConversationContext(conversation, personaOverrides || {});
            }

            console.log(`📱 Sending SMS to ${to}: ${message.substring(0, 50)}...`);

            let providerResponse = null;
            let messageSid = null;
            let status = null;
            let fromNumberUsed = fromNumber;

            if (this.provider === 'aws') {
                if (!this.awsAdapter) {
                    throw new Error('AWS Pinpoint adapter not configured');
                }
                const response = await this.awsAdapter.sendSms({
                    to,
                    body: message,
                    from: from || undefined,
                    context: {
                        persona: conversation.persona?.name || 'default'
                    }
                });

                const result = response?.MessageResponse?.Result?.[to] || {};
                providerResponse = response;
                messageSid = result.MessageId || null;
                status = result.DeliveryStatus || 'SUBMITTED';
                fromNumberUsed = result.OriginationNumber || from || this.awsAdapter?.config?.pinpoint?.originationNumber || null;
            } else if (this.provider === 'vonage') {
                if (!this.vonageAdapter) {
                    throw new Error('Vonage SMS adapter not configured');
                }

                const response = await this.vonageAdapter.sendSms({
                    to,
                    body: message,
                    from,
                    statusCallback: `https://${process.env.SERVER}/webhook/sms-status`
                });

                const [vonageResult] = response.messages || [];
                providerResponse = response;
                messageSid = vonageResult?.['message-id'] || null;
                status = vonageResult?.status === '0' ? 'sent' : vonageResult?.status || 'unknown';
                fromNumberUsed = from || this.vonageAdapter.fromNumber || null;
            } else {
                if (!fromNumber) {
                    throw new Error('No FROM_NUMBER configured for SMS');
                }

                const smsMessage = await this.twilio.messages.create({
                    body: message,
                    from: fromNumber,
                    to: to,
                    statusCallback: `https://${process.env.SERVER}/webhook/sms-status`
                });

                providerResponse = smsMessage;
                messageSid = smsMessage.sid;
                status = smsMessage.status;
                fromNumberUsed = fromNumber;
            }

            conversation.messages.push({
                role: 'assistant',
                content: message,
                timestamp: new Date(),
                message_sid: messageSid,
                provider: this.provider
            });
            conversation.last_activity = new Date();

            return {
                success: true,
                message_sid: messageSid,
                to: to,
                from: fromNumberUsed,
                body: message,
                status,
                persona: conversation.persona,
                providerResponse
            };
        } catch (error) {
            console.error('❌ SMS sending error:', error);
            throw error;
        }
    }

    // Send bulk SMS
    async sendBulkSMS(recipients, message, options = {}) {
        const results = [];
        const {
            delay = 1000, batchSize = 10
        } = options;

        console.log(`📱 Sending bulk SMS to ${recipients.length} recipients`);

        // Process in batches to avoid rate limiting
        for (let i = 0; i < recipients.length; i += batchSize) {
            const batch = recipients.slice(i, i + batchSize);
            const batchPromises = batch.map(async (recipient) => {
                try {
                    const result = await this.sendSMS(recipient, message);
                    return { ...result,
                        recipient,
                        success: true
                    };
                } catch (error) {
                    return {
                        recipient,
                        success: false,
                        error: error.message
                    };
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            results.push(...batchResults.map(r => r.value));

            // Add delay between batches
            if (i + batchSize < recipients.length) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        const successful = results.filter(r => r.success).length;
        const failed = results.length - successful;

        console.log(`📊 Bulk SMS completed: ${successful} sent, ${failed} failed`);

        return {
            total: recipients.length,
            successful,
            failed,
            results
        };
    }

    // AI-powered SMS conversation
    async handleIncomingSMS(from, body, messageSid) {
        try {
            console.log(`📨 Incoming SMS from ${from}: ${body}`);

            // Get or create conversation context
            let conversation = this.activeConversations.get(from);
            if (!conversation) {
                conversation = {
                    phone: from,
                    messages: [],
                    context: `You are a helpful SMS assistant. Keep responses concise (under 160 chars when possible). Be friendly and professional.`,
                    created_at: new Date(),
                    last_activity: new Date(),
                    personaProfile: { ...this.defaultSmsPersona }
                };
                this.activeConversations.set(from, conversation);
                this.composeConversationContext(conversation);
            }

            // Add incoming message to conversation
            conversation.messages.push({
                role: 'user',
                content: body,
                timestamp: new Date(),
                message_sid: messageSid
            });
            conversation.last_activity = new Date();

            const tone = this.analyzeTone(body);
            this.composeConversationContext(conversation, tone);

            // Generate AI response
            const aiResponse = await this.generateAIResponse(conversation);

            // Send response SMS
            const smsResult = await this.sendSMS(from, aiResponse);

            // Add AI response to conversation
            conversation.messages.push({
                role: 'assistant',
                content: aiResponse,
                timestamp: new Date(),
                message_sid: smsResult.message_sid
            });

            // Emit events for tracking
            this.emit('conversation_updated', {
                phone: from,
                conversation: conversation,
                ai_response: aiResponse
            });

            return {
                success: true,
                ai_response: aiResponse,
                message_sid: smsResult.message_sid
            };

        } catch (error) {
            console.error('❌ Error handling incoming SMS:', error);

            // Send fallback message
            try {
                await this.sendSMS(from, "Sorry, I'm experiencing technical difficulties. Please try again later.");
            } catch (fallbackError) {
                console.error('❌ Failed to send fallback message:', fallbackError);
            }

            throw error;
        }
    }

    // Generate AI response for SMS
    async generateAIResponse(conversation) {
        try {
            const messages = [{
                role: 'system',
                content: conversation.context
            }, ...conversation.messages.slice(-10) // Keep last 10 messages for context
            ];

            const completion = await this.openai.chat.completions.create({
                model: this.model,
                messages: messages,
                max_tokens: 150,
                temperature: 0.7
            });

            let response = completion.choices[0].message.content.trim();

            // Ensure response is SMS-friendly (under 1600 chars, ideally under 160)
            if (response.length > 1500) {
                response = response.substring(0, 1500) + "...";
            }

            return response;

        } catch (error) {
            console.error('❌ AI response generation error:', error);
            return "I apologize, but I'm having trouble processing your request right now. Please try again later.";
        }
    }

    // Get conversation history
    getConversation(phone) {
        return this.activeConversations.get(phone) || null;
    }

    // Get active conversations summary
    getActiveConversations() {
        const conversations = [];
        for (const [phone, conversation] of this.activeConversations.entries()) {
            conversations.push({
                phone,
                message_count: conversation.messages.length,
                created_at: conversation.created_at,
                last_activity: conversation.last_activity
            });
        }
        return conversations;
    }

    // Clean up old conversations
    cleanupOldConversations(maxAgeHours = 24) {
        const cutoff = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
        let cleanedCount = 0;

        for (const [phone, conversation] of this.activeConversations.entries()) {
            if (conversation.last_activity < cutoff) {
                this.activeConversations.delete(phone);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} old SMS conversations`);
        }

        return cleanedCount;
    }

    // Schedule SMS for later sending
    async scheduleSMS(to, message, scheduledTime, options = {}) {
        const scheduleData = {
            to,
            message,
            scheduledTime: new Date(scheduledTime),
            created_at: new Date(),
            options,
            status: 'scheduled'
        };

        // In a real implementation, this would be stored in database
        // For now, we'll use a simple Map
        const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.messageQueue.set(scheduleId, scheduleData);

        console.log(`📅 SMS scheduled for ${scheduledTime}: ${scheduleId}`);

        return {
            schedule_id: scheduleId,
            scheduled_time: scheduledTime,
            status: 'scheduled'
        };
    }

    // Process scheduled messages
    async processScheduledMessages() {
        const now = new Date();
        const toSend = [];

        for (const [scheduleId, scheduleData] of this.messageQueue.entries()) {
            if (scheduleData.status === 'scheduled' && scheduleData.scheduledTime <= now) {
                toSend.push({
                    scheduleId,
                    scheduleData
                });
            }
        }

        for (const {
                scheduleId,
                scheduleData
            } of toSend) {
            try {
                const result = await this.sendSMS(scheduleData.to, scheduleData.message);
                scheduleData.status = 'sent';
                scheduleData.sent_at = new Date();
                scheduleData.message_sid = result.message_sid;

                console.log(`📱 Scheduled SMS sent: ${scheduleId}`);
            } catch (error) {
                console.error(`❌ Failed to send scheduled SMS ${scheduleId}:`, error);
                scheduleData.status = 'failed';
                scheduleData.error = error.message;
            }
        }

        return toSend.length;
    }

    getBuiltinTemplates(includeContent = true) {
        return Object.values(this.builtinTemplates).map((template) => ({
            name: template.name,
            description: template.description,
            is_builtin: true,
            content: includeContent ? template.content : undefined
        }));
    }

    async listTemplates(options = {}) {
        const { includeContent = false, includeBuiltin = true } = options;
        const custom = this.db
            ? await this.db.getAllTemplates({ includeContent })
            : [];

        const customTemplates = custom.map((template) => ({
            id: template.id,
            name: template.name,
            description: template.description,
            content: includeContent ? template.content : undefined,
            metadata: template.metadata,
            is_builtin: !!template.is_builtin,
            created_by: template.created_by,
            updated_by: template.updated_by,
            created_at: template.created_at,
            updated_at: template.updated_at
        }));

        const builtinTemplates = includeBuiltin
            ? this.getBuiltinTemplates(includeContent)
            : [];

        return {
            custom: customTemplates,
            builtin: builtinTemplates
        };
    }

    async fetchTemplateDefinition(templateName) {
        if (this.db) {
            const customTemplate = await this.db.getTemplateByName(templateName);
            if (customTemplate) {
                return {
                    name: customTemplate.name,
                    description: customTemplate.description,
                    content: customTemplate.content,
                    metadata: customTemplate.metadata,
                    is_builtin: !!customTemplate.is_builtin
                };
            }
        }

        const builtin = this.builtinTemplates[templateName];
        if (builtin) {
            return {
                name: builtin.name,
                description: builtin.description,
                content: builtin.content,
                metadata: {},
                is_builtin: true
            };
        }

        return null;
    }

    applyTemplateVariables(templateContent, variables = {}) {
        let rendered = templateContent;
        if (variables && typeof variables === 'object') {
            for (const [key, value] of Object.entries(variables)) {
                rendered = rendered.replace(new RegExp(`{${key}}`, 'g'), value);
            }
        }
        return rendered;
    }

    async renderTemplate(templateName, variables = {}) {
        const definition = await this.fetchTemplateDefinition(templateName);
        if (!definition) {
            throw new Error(`Template '${templateName}' not found`);
        }
        const content = this.applyTemplateVariables(definition.content, variables);
        return {
            ...definition,
            rendered: content,
            variables
        };
    }

    async getTemplate(templateName, variables = {}) {
        const rendered = await this.renderTemplate(templateName, variables);
        return rendered.rendered;
    }

    // Get service statistics
    getStatistics() {
        const activeConversations = this.activeConversations.size;
        const scheduledMessages = Array.from(this.messageQueue.values())
            .filter(msg => msg.status === 'scheduled').length;

        return {
            active_conversations: activeConversations,
            scheduled_messages: scheduledMessages,
            total_conversations_today: activeConversations, // Would be from DB in real implementation
            message_queue_size: this.messageQueue.size
        };
    }
}

module.exports = { EnhancedSmsService };
