module.exports = {
  sprintRouting: {
    workspaceId: '9017847808',
    backlogListId: '901718154839',
    sprintFolderId: '901712161187',
    // Record a sprint's List ID here after using ClickUp's Complete Sprint action.
    completedSprintIds: [],
    sprintTasks: {
      enabled: true,
      initialStatus: 'backlog'
    },
    // Checking the sprint checkbox copies the backlog task into the testing List.
    acceptanceTesting: {
      enabled: true,
      checkboxField: 'Ready for acceptance testing',
      listId: '901718171744',
      testingStatus: 'ready to test',
      backlogStatus: 'in testing',
      sprintStatus: 'testing',
      // Moving the testing task to completeStatus moves the backlog task from backlogStatus to backlogCompleteStatus.
      completeStatus: 'test complete',
      backlogCompleteStatus: 'ready to deploy',
      // Moving the backlog task to any of these archives its testing copy.
      archiveOnStatuses: ['deployed']
    },
    // Moving a backlog task to triggerStatus copies it into the estimation List; reaching
    // readyStatus there with a positive Effort Estimate copies the estimate back to the backlog task.
    estimation: {
      enabled: true,
      triggerStatus: 'awaiting estimation',
      resetStatus: 'new backlog',
      listId: '901718172231',
      initialStatus: 'awaiting estimate',
      readyStatus: 'estimate ready',
      estimateField: 'Effort Estimate',
      // Moving the backlog task into a sprint archives its estimation copy.
      archiveOnStatuses: ['sprint 0', 'sprint +1', 'sprint +2']
    },
    // The daily check creates the next sequential sprint List until this many sprints start after today.
    sprintCreation: {
      enabled: true,
      futureSprints: 3
    },
    // Emailed after each daily check; SMTP_USER/SMTP_PASS (and optional SMTP_HOST/PORT/FROM) come from .env.
    healthEmail: {
      enabled: true,
      to: 'john@towpro.io',
      subject: 'Clickup Webhook Service is healthy',
      failureSubject: 'Clickup Webhook Service daily check FAILED',
      timeZone: 'America/New_York'
    },
    workflowValidation: {
      enabled: true,
      intervalMinutes: 15,
      recentDays: 7
    },
    daily: {
      enabled: true,
      timeZone: 'America/New_York',
      hour: 0,
      minute: 5
    }
  }
};
