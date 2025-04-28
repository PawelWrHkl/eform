import { logFunctionName,
    buildValuesToDisplay,
    resetDependences,
    updateFieldInputs,
    updateFieldStates,

 } from './formTools.js';

 export class DialogManager {
    constructor() {
        this.dialog = document.getElementById('color-dialog');
        this.dialogContainer = document.getElementById('dialog-container');
        this.listContainer = document.getElementById('dynamic-options-list');
        this.dialogTitle = document.getElementById('dialog-title');
        this.confirmButton = document.getElementById('confirm-button');
        this.closeButton = document.getElementById('dialog-close');
        this.options = [];
        this.param = null;
        this.groupNumber = null;
        this.activeFilters = {};

        if (this.confirmButton) {
         this.confirmButton.addEventListener('click', () => {
                this.handleConfirm();
            });
        }
        if (this.closeButton) {
            this.closeButton.addEventListener('click', () => {
                this.dialog.close();
            }); 
        }
    }
    async initialize(param,options,groupNumber) {
        logFunctionName('Dialog Initialize');
        this.param = param;
        this.options = options;
        this.groupNumber = groupNumber;

        if (this.dialogTitle){
            this.dialogTitle.textContent = `Wybór ${param.DESCRIPTION}`;
        }

        const imageMap = await this.fetchImageMap(param, options, groupNumber);

    }

    handleConfirm(){
        const selectedData = this.getSelectedValue();
        if(! selectedData){
            
        }
    }

}