/**
 * Chad Routes - Main route aggregator
 */

const express = require('express');
const cors = require('cors');

const healthRoutes = require('./health');
const sessionsRoutes = require('./sessions');
const chatRoutes = require('./chat');
const catalogRoutes = require('./catalog');
const sourcesRoutes = require('./sources');
const extractionsRoutes = require('./extractions');
const teamChatRoutes = require('./teamChat');

const app = express();
app.use(cors());
app.use(express.json());

// Mount routes
app.use('/', healthRoutes);
app.use('/api', sessionsRoutes);
app.use('/api', chatRoutes);
app.use('/api', catalogRoutes);
app.use('/api/sources', sourcesRoutes);
app.use('/api/extractions', extractionsRoutes);
app.use('/api/team-chat', teamChatRoutes);

module.exports = app;
