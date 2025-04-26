import { logFunctionName } from './formTools.js';

export async function createDialog(param, options, grNr) {
    logFunctionName('createDialog')

    let jsonBody= JSON.stringify({ 
        options: options, 
        groupNumber: grNr, 
        folderName: param.NAME 
    })
    const response = await fetch('/position/check-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody
    });
    
    const imageMap = await response.json();

    const colorDialog = document.getElementById('color-dialog');
    const listOfParams = document.getElementById('dynamic-options-list');
    listOfParams.innerHTML = '';

    for (let option of options) {
        const colorBox = document.createElement('div');

    colorBox.addEventListener('click', () => {
        document.querySelectorAll('.image-box').forEach(e => e.classList.remove('active'));
        colorBox.classList.add('active');
        colorBox.dataset.paramName = param.NAME;
        colorBox.dataset.paramDescription = option.DESCRIPTION;
    });
        
        colorBox.classList.add('image-box')
        colorBox.id=option.VALUE;
        const colorName = document.createElement('p');
        colorName.classList.add('image-name');
        colorName.innerHTML = `${option.VALUE}<br>${option.DESCRIPTION}`;
        colorName.dataset.id = `${option.ROW_NUM}-${param.NAME}`;
        colorName.dataset.value = option.VALUE;
        const colorImage = document.createElement('img');
        colorImage.classList.add('diag-image');
        

        const ext = imageMap[option.VALUE];
        if (ext) {
            const imageSrc = `/data/${grNr}/${param.NAME}/${option.VALUE}.${ext}`;
            colorImage.src = imageSrc;
            colorImage.classList.add('diag-image');
        
            const previewOverlay = document.createElement('img');
            previewOverlay.classList.add('preview-box');
            previewOverlay.src='/img/window.png'
            previewOverlay.addEventListener('click', (e) => {
                
                const previewDialog = document.getElementById('image-preview-dialog');
                const previewImage = document.getElementById('preview-image');
                previewImage.src = imageSrc;
                previewDialog.showModal();
            });
        
            const imageWrapper = document.createElement('div');
            imageWrapper.classList.add('image-wrapper');
            imageWrapper.appendChild(colorImage);
            imageWrapper.appendChild(previewOverlay);
        
            colorBox.appendChild(imageWrapper);
        }

        colorBox.appendChild(colorName);
        listOfParams.appendChild(colorBox);
    }
    colorDialog.showModal()
}

